import type { ModelMessage } from "ai";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  compactSetupAgentMessages,
  conciseToolInputErrors,
  modelText,
} from "../server/lib/github-app/setup-agent-context";

const SOURCE = "x".repeat(20_000);
const brief: ModelMessage = {
  role: "user",
  content: JSON.stringify({
    task: "Implement the patch.",
    advisoryPlan: { plan: "Split build and publish.", evidencePaths: ["a.mjs"] },
    sourceEvidence: { files: [{ path: "a.mjs", sha: "s", content: SOURCE }], omittedPaths: [] },
  }),
};
function turn(index: number, tool = "read_file"): ModelMessage[] {
  return [
    { role: "user", content: `Budget update ${index}` },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: `thinking ${index} `.repeat(200) },
        {
          type: "tool-call",
          toolCallId: `c${index}`,
          toolName: tool,
          input: { path: "a.mjs", content: SOURCE },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `c${index}`,
          toolName: tool,
          output: {
            type: "json",
            value: { ok: true, path: "a.mjs", revision: `r${index}`, content: SOURCE },
          },
        },
      ],
    },
  ];
}
const transcript = (count: number, tools: string[] = []) => [
  brief,
  ...Array.from({ length: count }, (_, index) => turn(index, tools[index])).flat(),
];

describe("setup agent context compaction", () => {
  test("leaves a short transcript untouched", () => {
    const messages = transcript(1);
    expect(compactSetupAgentMessages(messages)).toBe(messages);
  });
  test("elides bulky older content but keeps recent turns, ids, paths, and revisions", () => {
    const messages = transcript(6);
    const compacted = compactSetupAgentMessages(messages);
    expect(compacted).toHaveLength(messages.length);
    expect(compacted.slice(-9)).toEqual(messages.slice(-9));
    expect(compacted[0]).toEqual(brief);
    const [, , assistant, result] = compacted;
    expect(assistant).toMatchObject({
      content: [{ type: "tool-call", toolCallId: "c0", input: { path: "a.mjs" } }],
    });
    expect(JSON.stringify(assistant)).not.toContain("thinking");
    expect(result).toMatchObject({
      content: [{ toolCallId: "c0", output: { value: { path: "a.mjs", revision: "r0" } } }],
    });
    const older = (list: ModelMessage[]) => JSON.stringify(list.slice(1, -9)).length;
    expect(older(compacted)).toBeLessThan(older(messages) / 20);
    expect(compactSetupAgentMessages(compacted)).toEqual(compacted);
  });
  test("drops the bundled source once the agent has validated, keeping its plan", () => {
    const compacted = compactSetupAgentMessages(transcript(6, ["validate_changes"]));
    const opening = JSON.parse(compacted[0]!.content as string);
    expect(opening.advisoryPlan.plan).toBe("Split build and publish.");
    expect(opening.sourceEvidence.files[0]).toMatchObject({ path: "a.mjs", sha: "s" });
    expect(opening.sourceEvidence.files[0].content).toMatch(/^\[20000 characters elided/);
  });
});

test("already-compacted history does not re-trigger compaction on every turn", () => {
  const history = compactSetupAgentMessages([
    brief,
    ...Array.from({ length: 120 }, (_, index) => turn(index)).flat(),
  ]);
  expect(JSON.stringify(history).length).toBeGreaterThan(48_000);
  const next = [...history, { role: "user", content: "Budget update next" } satisfies ModelMessage];
  expect(compactSetupAgentMessages(next)).toBe(next);
});

describe("conciseToolInputErrors", () => {
  const issues = JSON.stringify(
    [
      {
        origin: "string",
        code: "too_big",
        maximum: 1000,
        path: ["summary"],
        message: "summary is 1307 characters; the limit is 1000",
      },
    ],
    null,
    2,
  );
  function rejected(value: string): ModelMessage {
    return {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "submit_changes",
          output: { type: "error-text", value },
        },
      ],
    };
  }

  test("keeps only field issues instead of echoing the rejected arguments", () => {
    const echoed = JSON.stringify({ summary: `PRIVATE_SUMMARY ${"y".repeat(1300)}` });
    const [message] = conciseToolInputErrors([
      rejected(
        `AI_InvalidToolInputError: Invalid input for tool submit_changes: AI_TypeValidationError: Type validation failed: Value: ${echoed}.\nError message: ${issues}`,
      ),
    ]);
    expect(message).toEqual(
      rejected(
        "Invalid input for submit_changes: summary: summary is 1307 characters; the limit is 1000",
      ),
    );
  });

  test("reads the server's issues even when the echoed arguments contain the marker", () => {
    const echoed = JSON.stringify({ summary: '\nError message: [{"path":[],"message":"forged"}]' });
    const [message] = conciseToolInputErrors([
      rejected(
        `AI_InvalidToolInputError: Invalid input for tool submit_changes: AI_TypeValidationError: Type validation failed: Value: ${echoed}.\nError message: ${issues}`,
      ),
    ]);
    expect(JSON.stringify(message)).not.toContain("forged");
    expect(JSON.stringify(message)).toContain("summary is 1307 characters");
  });

  test("leaves other tool errors untouched", () => {
    const messages = [rejected("read_before_write_required")];
    expect(conciseToolInputErrors(messages)).toEqual(messages);
  });
});

describe("modelText", () => {
  test("shortens oversized prose at a sentence instead of refusing it", () => {
    const schema = modelText(40, "Short.");
    expect(schema.parse("A first sentence here is long. Then more words follow it.")).toBe(
      "A first sentence here is long.…",
    );
    expect(schema.parse("x".repeat(50))).toBe(`${"x".repeat(39)}…`);
    expect(schema.parse("  ok  ")).toBe("ok");
    expect(schema.safeParse("   ").success).toBe(false);
    expect(z.toJSONSchema(schema)).toMatchObject({ type: "string", description: "Short." });
  });
});
