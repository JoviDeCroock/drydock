import { afterEach, describe, expect, test, vi } from "vitest";
import { AI_MODEL } from "../server/lib/ai-review";
import {
  generateSetupCandidate,
  generateSetupDraft,
  verifySetupProposal,
} from "../server/lib/github-app/setup-draft";
import { judgeSetupDraft } from "../server/lib/github-app/setup-judge";
import { canonicalJson } from "../server/lib/platform/canonical-json";
import { base64UrlEncode, hmacSha256 } from "../server/lib/platform/crypto-utils";
import {
  SETUP_DRAFT_REQUEST,
  SETUP_NPM_GUIDE_WORKFLOW,
  SETUP_ORIGINAL_WORKFLOW,
  setupProposal,
} from "./helpers/publisher-setup-fixtures";

afterEach(() => vi.restoreAllMocks());

function aiBinding(output: unknown, finishReason = "stop") {
  const run = vi.fn(async (_model: string, _input: unknown, _options: unknown) => ({
    response: typeof output === "string" ? output : JSON.stringify(output),
    finish_reason: finishReason,
    usage: { prompt_tokens: 100, completion_tokens: 100 },
  }));
  return { run, env: { AI: { run } } as unknown as Cloudflare.Env };
}

const candidate = { content: SETUP_NPM_GUIDE_WORKFLOW, summary: "Drafter explanation." };
const pass = { verdict: "pass", summary: "The same package bytes are published.", issues: [] };

describe("publisher setup model boundary", () => {
  test("uses private GLM text output with enough time for a durable step", async () => {
    const { run, env } = aiBinding(candidate.content);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    expect(await generateSetupCandidate(env, SETUP_DRAFT_REQUEST, SETUP_ORIGINAL_WORKFLOW)).toEqual(
      {
        content: candidate.content.trim(),
        summary: "Proposed publishing workflow change for maintainer review.",
      },
    );
    const [model, input, options] = run.mock.calls[0];
    expect(model).toBe(AI_MODEL);
    expect(input).toMatchObject({
      reasoning_effort: "high",
      max_tokens: 12000,
    });
    expect(input).not.toHaveProperty("response_format");
    expect(options).toMatchObject({
      gateway: { id: "drydock-gateway" },
      extraHeaders: {
        "cf-aig-collect-log-payload": "false",
        "cf-aig-max-attempts": "1",
        "cf-aig-skip-cache": "true",
      },
    });
    expect(timeout).toHaveBeenCalledWith(180_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test.each([candidate.content, "```yaml\n" + candidate.content + "\n```"])(
    "accepts the complete YAML response, including an enclosing transport fence %#",
    async (output) => {
      const { env } = aiBinding(output);
      const draft = await generateSetupDraft(env, SETUP_DRAFT_REQUEST, SETUP_ORIGINAL_WORKFLOW);
      expect(draft.content.trim()).toBe(candidate.content.trim());
    },
  );

  test.each([
    "# This would be a workflow",
    "Here is the workflow:\n```yaml\n" + candidate.content + "\n```",
    JSON.stringify({ content: candidate.content }),
    "name: Release,on:,workflow_dispatch:,jobs:",
    "x".repeat(48_001),
  ])("rejects malformed, partial, wrapped or oversized source %#", async (output) => {
    const { env } = aiBinding(output);
    await expect(
      generateSetupDraft(env, SETUP_DRAFT_REQUEST, SETUP_ORIGINAL_WORKFLOW),
    ).rejects.toThrow();
  });

  test("refuses a syntactically valid workflow when its model response was truncated", async () => {
    const { run, env } = aiBinding(candidate.content, "length");
    await expect(
      generateSetupDraft(env, SETUP_DRAFT_REQUEST, SETUP_ORIGINAL_WORKFLOW),
    ).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("the judge independently receives both files without the drafter explanation", async () => {
    const { run, env } = aiBinding(pass);
    expect(
      await judgeSetupDraft(env, SETUP_DRAFT_REQUEST, SETUP_ORIGINAL_WORKFLOW, candidate),
    ).toEqual({
      ...pass,
      model: AI_MODEL,
    });
    const [, input, options] = run.mock.calls[0];
    const messages = (input as { messages: { content: string }[] }).messages;
    expect(JSON.parse(messages.at(-1)!.content)).toMatchObject({
      originalWorkflow: SETUP_ORIGINAL_WORKFLOW,
      proposedWorkflow: candidate.content,
      environment: SETUP_DRAFT_REQUEST.environment,
      artifactName: "npm-release-candidates",
    });
    expect(JSON.stringify(input)).not.toContain(candidate.summary);
    expect(options).toMatchObject({
      extraHeaders: { "cf-aig-collect-log-payload": "false", "cf-aig-max-attempts": "1" },
    });
  });

  test("a judge cannot override deterministic rejection", async () => {
    const { run, env } = aiBinding(pass);
    await expect(
      judgeSetupDraft(env, SETUP_DRAFT_REQUEST, SETUP_ORIGINAL_WORKFLOW, {
        ...candidate,
        content: candidate.content.replace("environment: production", "environment: other"),
      }),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  test("returns a negative assessment for the job to present without signing", async () => {
    const assessment = {
      verdict: "changes_requested",
      summary: "The package set changes.",
      issues: ["Preserve the original workspace package selection."],
    };
    const { env } = aiBinding(assessment);
    expect(
      await judgeSetupDraft(env, SETUP_DRAFT_REQUEST, SETUP_ORIGINAL_WORKFLOW, candidate),
    ).toEqual({
      ...assessment,
      model: AI_MODEL,
    });
  });

  test.each([
    { ...pass, issues: ["A blocking issue."] },
    { ...pass, verdict: "changes_requested" },
    { ...pass, verdict: "approved" },
    { ...pass, summary: "" },
    { ...pass, arbitraryField: "ignored" },
  ])("rejects an inconsistent or malformed judge assessment %#", async (assessment) => {
    const { env } = aiBinding(assessment);
    await expect(
      judgeSetupDraft(env, SETUP_DRAFT_REQUEST, SETUP_ORIGINAL_WORKFLOW, candidate),
    ).rejects.toThrow();
  });

  test("truncated model output fails closed without an SDK retry", async () => {
    const { run, env } = aiBinding(pass, "length");
    await expect(
      judgeSetupDraft(env, SETUP_DRAFT_REQUEST, SETUP_ORIGINAL_WORKFLOW, candidate),
    ).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("rejects an otherwise valid proposal signed before the judge requirement", async () => {
    const proposal = setupProposal();
    const legacyToken = base64UrlEncode(
      await hmacSha256(
        "secret",
        canonicalJson({
          purpose: "drydock.publisher-setup.v1",
          proposal,
          organizationId: "org",
          userId: "user",
        }),
      ),
    );
    expect(await verifySetupProposal("secret", proposal, legacyToken, "org", "user")).toBe(false);
  });
});
