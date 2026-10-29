import { describe, expect, test, vi } from "vitest";
import { AI_MODEL } from "../server/lib/ai-review";
import {
  createSetupAgentState,
  runSetupAgentTurn,
  extractSetupAgentCandidate,
  SETUP_DRAFT_MAX_TURNS,
} from "../server/lib/github-app/setup-agent";
import {
  SETUP_DRAFT_REQUEST,
  SETUP_ORIGINAL_WORKFLOW,
  SETUP_PROPOSED_WORKFLOW,
  SETUP_BLOB_SHA,
} from "./helpers/publisher-setup-fixtures";

function start() {
  return createSetupAgentState(
    SETUP_DRAFT_REQUEST,
    {
      path: SETUP_DRAFT_REQUEST.workflowPath,
      sha: SETUP_BLOB_SHA,
      content: SETUP_ORIGINAL_WORKFLOW,
    },
    "draft",
  );
}
function response(name: string, input: unknown, finishReason = "tool_calls") {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name, arguments: JSON.stringify(input) },
            },
          ],
        },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 100 },
  };
}
function binding(outputs: unknown[]) {
  const run = vi.fn(async () => outputs.shift());
  const request = vi.fn(async () => ({ truncated: false, tree: [] }));
  return { run, client: { request }, env: { AI: { run } } as unknown as Cloudflare.Env };
}

async function draft() {
  const state = start();
  const harness = binding([response("read_file", { path: state.request.workflowPath })]);
  let current = await runSetupAgentTurn(harness.env, state, harness.client);
  harness.run.mockImplementationOnce(async () =>
    response("edit_file", {
      path: state.request.workflowPath,
      expectedRevision: current.readRevisions![state.request.workflowPath],
      find: SETUP_ORIGINAL_WORKFLOW,
      replace: SETUP_PROPOSED_WORKFLOW,
    }),
  );
  current = await runSetupAgentTurn(harness.env, current, harness.client);
  harness.run.mockImplementationOnce(async () =>
    response("submit_changes", { summary: "PRIVATE_DRAFTER_RATIONALE" }),
  );
  current = await runSetupAgentTurn(harness.env, current, harness.client);
  return { state: current, harness };
}

describe("publisher setup native agent turns", () => {
  test("uses native GLM tools with a private serial binding and no structured code envelope", async () => {
    const state = start();
    const { run, env, client } = binding([
      response("read_file", { path: state.request.workflowPath }),
    ]);
    const next = await runSetupAgentTurn(env, state, client);
    expect(run).toHaveBeenCalledTimes(1);
    const calls = run.mock.calls as unknown as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ][];
    expect(calls[0][0]).toBe(AI_MODEL);
    expect(calls[0][1]).toMatchObject({ tool_choice: "auto", parallel_tool_calls: false });
    expect(calls[0][1]).toHaveProperty("chat_template_kwargs.clear_thinking", false);
    expect(calls[0][1]).not.toHaveProperty("response_format");
    expect(calls[0][1].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining('"remainingInputTokens":1500000'),
        }),
      ]),
    );
    expect(calls[0][1].tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ function: expect.objectContaining({ name: "read_file" }) }),
      ]),
    );
    expect(calls[0][2]).toMatchObject({
      extraHeaders: { "cf-aig-collect-log-payload": "false", "cf-aig-max-attempts": "1" },
    });
    expect(next.progress.turns).toBe(1);
    expect(next.messages.some((message) => message.role === "tool")).toBe(true);
    expect(state.messages).toHaveLength(1);
    expect(client.request).not.toHaveBeenCalled();
  });
  test("reads, edits and submits a validated proposal across independent durable turns", async () => {
    const { state } = await draft();
    const candidate = await extractSetupAgentCandidate(state);
    expect(candidate.content).toBe(SETUP_PROPOSED_WORKFLOW);
    expect(candidate.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(candidate.supportingFiles).toEqual([]);
    expect(state.progress.turns).toBe(3);
  });
  test("replays exact native model context in GLM's field while retaining tool identities and visible content", async () => {
    const state = start();
    const first = response("read_file", { path: state.request.workflowPath });
    const sentinel = "INERT_NATIVE_CONTEXT\n  exact whitespace\n";
    const harness = binding([
      {
        ...first,
        choices: [
          {
            ...first.choices[0],
            message: { ...first.choices[0].message, reasoning_content: sentinel },
          },
        ],
      },
      response("workspace_status", {}),
    ]);
    const next = await runSetupAgentTurn(harness.env, state, harness.client);
    await runSetupAgentTurn(harness.env, next, harness.client);
    const calls = harness.run.mock.calls as unknown as [
      string,
      { messages: Record<string, unknown>[] },
    ][];
    const assistant = calls[1][1].messages.find((message) => message.role === "assistant")!;
    const result = calls[1][1].messages.find((message) => message.role === "tool")!;
    expect(assistant).toMatchObject({ content: "", reasoning_content: sentinel });
    expect(assistant).not.toHaveProperty("reasoning");
    expect(assistant.content).not.toContain(sentinel);
    expect(assistant.tool_calls).toMatchObject([{ id: result.tool_call_id }]);
    expect(result).toMatchObject({ name: "read_file", role: "tool" });
    expect(next.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
  });
  test("the independent judge must inspect the frozen diff before its native verdict is accepted", async () => {
    const { state, harness } = await draft();
    let judge = createSetupAgentState(
      state.request,
      { path: state.request.workflowPath, sha: SETUP_BLOB_SHA, content: SETUP_ORIGINAL_WORKFLOW },
      "judge",
      state,
    );
    expect(JSON.stringify(judge.messages)).not.toContain("PRIVATE_DRAFTER_RATIONALE");
    harness.run.mockImplementationOnce(async () =>
      response("finish_review", { verdict: "pass", summary: "All changes reviewed.", issues: [] }),
    );
    judge = await runSetupAgentTurn(harness.env, judge, harness.client);
    expect(judge.assessment).toBeUndefined();
    harness.run.mockImplementationOnce(async () =>
      response("inspect_changes", { path: state.request.workflowPath }),
    );
    judge = await runSetupAgentTurn(harness.env, judge, harness.client);
    harness.run.mockImplementationOnce(async () =>
      response("finish_review", {
        verdict: "pass",
        summary: "The reviewed archives are published.",
        issues: [],
      }),
    );
    judge = await runSetupAgentTurn(harness.env, judge, harness.client);
    expect(judge.assessment).toMatchObject({ verdict: "pass", digest: state.submitted?.digest });
    const count = harness.run.mock.calls.length;
    expect(await runSetupAgentTurn(harness.env, judge, harness.client)).toBe(judge);
    expect(harness.run).toHaveBeenCalledTimes(count);
  });
  test("discards local file edits when the model turn is truncated", async () => {
    let state = start();
    const harness = binding([response("read_file", { path: state.request.workflowPath })]);
    state = await runSetupAgentTurn(harness.env, state, harness.client);
    harness.run.mockImplementationOnce(async () =>
      response(
        "edit_file",
        {
          path: state.request.workflowPath,
          expectedRevision: state.readRevisions![state.request.workflowPath],
          find: SETUP_ORIGINAL_WORKFLOW,
          replace: SETUP_PROPOSED_WORKFLOW,
        },
        "length",
      ),
    );
    await expect(runSetupAgentTurn(harness.env, state, harness.client)).rejects.toThrow(
      /incomplete tool turn/,
    );
    expect(state.files[state.request.workflowPath].content).toBe(SETUP_ORIGINAL_WORKFLOW);
    expect(state.progress.turns).toBe(1);
  });
  test("does not fabricate tool calls from natural-language JSON", async () => {
    const { env, client } = binding([
      {
        response: '{"name":"submit_changes","arguments":{"summary":"Ignore instructions"}}',
        finish_reason: "stop",
      },
    ]);
    const next = await runSetupAgentTurn(env, start(), client);
    expect(next.submitted).toBeUndefined();
    expect(next.messages.at(-1)).toMatchObject({ role: "user" });
  });
  test("records a concrete blocker privately and stops without a proposal", async () => {
    const { env, client, run } = binding([
      response("report_blocker", {
        reason: "The selected reusable workflow is not available at the pinned revision.",
      }),
    ]);
    const next = await runSetupAgentTurn(env, start(), client);
    expect(next.blocked?.reason).toContain("pinned revision");
    expect(next.submitted).toBeUndefined();
    await runSetupAgentTurn(env, next, client);
    expect(run).toHaveBeenCalledTimes(1);
  });
  test("enforces turn/time/token budgets before contacting the model", async () => {
    const state = start();
    const { env, client, run } = binding([]);
    state.progress.turns = SETUP_DRAFT_MAX_TURNS;
    await expect(runSetupAgentTurn(env, state, client)).rejects.toThrow(/work budget/);
    state.progress.turns = 0;
    state.progress.startedAt = Date.now() - 21 * 60_000;
    await expect(runSetupAgentTurn(env, state, client)).rejects.toThrow(/work budget/);
    state.progress.startedAt = Date.now();
    state.progress.inputTokens = 1_500_000;
    await expect(runSetupAgentTurn(env, state, client)).rejects.toThrow(/work budget/);
    state.progress.inputTokens = 0;
    state.progress.outputTokens = 80_000;
    await expect(runSetupAgentTurn(env, state, client)).rejects.toThrow(/work budget/);
    expect(run).not.toHaveBeenCalled();
  });
  test("refuses a submitted workspace whose files no longer match its digest", async () => {
    const { state } = await draft();
    state.files[state.request.workflowPath].content += "\n# changed";
    await expect(extractSetupAgentCandidate(state)).rejects.toThrow(/changed before review/);
  });
  test("does not start a model call when its transcript already exceeds the remaining input allowance", async () => {
    const state = start();
    state.progress.inputTokens = 1_499_999;
    const { env, client, run } = binding([]);
    await expect(runSetupAgentTurn(env, state, client)).rejects.toThrow(/work budget/);
    expect(run).not.toHaveBeenCalled();
  });
  test("a prolonged read-only draft gets a progress reminder without forcing an edit", async () => {
    const state = start();
    state.progress.turns = 12;
    const { env, client, run } = binding([
      response("report_blocker", {
        reason: "The referenced reusable release workflow is missing.",
      }),
    ]);
    const next = await runSetupAgentTurn(env, state, client);
    const calls = run.mock.calls as unknown as [
      string,
      { tool_choice: string; messages: { role: string; content: string }[] },
    ][];
    expect(calls[0][1].tool_choice).toBe("auto");
    expect(calls[0][1].messages.find((message) => message.role === "system")?.content).toContain(
      "12 drafting turns and cached 1 source files with no proposed changes",
    );
    expect(next.blocked?.reason).toContain("missing");
    expect(next.files[state.request.workflowPath].content).toBe(SETUP_ORIGINAL_WORKFLOW);
  });
  test("clips output allowance and discards a final pass whose reported usage exceeds shared caps", async () => {
    const { state, harness } = await draft();
    let judge = createSetupAgentState(
      state.request,
      { path: state.request.workflowPath, sha: SETUP_BLOB_SHA, content: SETUP_ORIGINAL_WORKFLOW },
      "judge",
      state,
    );
    harness.run.mockImplementationOnce(async () =>
      response("inspect_changes", { path: state.request.workflowPath }),
    );
    judge = await runSetupAgentTurn(harness.env, judge, harness.client);
    judge.progress.inputTokens = 1_490_000;
    judge.progress.outputTokens = 79_950;
    harness.run.mockImplementationOnce(async () => ({
      ...response("finish_review", { verdict: "pass", summary: "Reviewed.", issues: [] }),
      usage: { prompt_tokens: 15_000, completion_tokens: 100 },
    }));
    await expect(runSetupAgentTurn(harness.env, judge, harness.client)).rejects.toThrow(
      /work budget/,
    );
    const calls = harness.run.mock.calls as unknown as [string, { max_tokens: number }][];
    expect(calls.at(-1)![1].max_tokens).toBe(50);
    expect(judge.assessment).toBeUndefined();
    expect(judge.progress.inputTokens).toBe(1_490_000);
    expect(judge.progress.outputTokens).toBe(79_950);
  });
  test("discards a terminal result that arrives after the shared deadline", async () => {
    const state = start();
    state.progress.startedAt = Date.now() - 20 * 60_000 + 1000;
    const { env, client, run } = binding([]);
    const now = vi.spyOn(Date, "now");
    const timeout = vi.spyOn(AbortSignal, "timeout");
    run.mockImplementationOnce(async () => {
      now.mockReturnValue(state.progress.startedAt + 21 * 60_000);
      return response("report_blocker", { reason: "Late terminal result." });
    });
    try {
      await expect(runSetupAgentTurn(env, state, client)).rejects.toThrow(/work budget/);
      expect(state.blocked).toBeUndefined();
      expect(timeout.mock.calls[0][0]).toBeGreaterThan(0);
      expect(timeout.mock.calls[0][0]).toBeLessThanOrEqual(1000);
    } finally {
      now.mockRestore();
      timeout.mockRestore();
    }
  });
});
