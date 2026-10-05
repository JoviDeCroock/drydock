import { afterEach, describe, expect, test, vi } from "vitest";
import { askClef, CLEF_MODEL } from "../server/lib/ai-review/clef.ts";

const NOUL = { type: "noul", instructions: "Is it so?" };
const SCORE = { type: "score", instructions: "How much?", criteria: ["none", "some", "a lot"] };
const OPTIONS = { timeoutMs: 1_000 };

function binding(respond) {
  return { run: vi.fn(respond) };
}

function answering(body) {
  return binding(async () => body);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("askClef", () => {
  test("does not call the binding when Workers AI is not configured", async () => {
    expect(await askClef(undefined, {}, { q: NOUL }, OPTIONS)).toEqual({
      ok: false,
      reason: "not_configured",
    });
  });

  test("refuses an empty or oversized batch without asking", async () => {
    const ai = answering({ answers: {} });
    const oversized = Object.fromEntries(Array.from({ length: 65 }, (_v, i) => [`q${i}`, NOUL]));

    expect(await askClef(ai, {}, {}, OPTIONS)).toEqual({ ok: false, reason: "empty_request" });
    expect(await askClef(ai, {}, oversized, OPTIONS)).toEqual({
      ok: false,
      reason: "empty_request",
    });
    expect(ai.run).not.toHaveBeenCalled();
  });

  test("accepts a batch at the 64-question ceiling", async () => {
    const questions = Object.fromEntries(Array.from({ length: 64 }, (_v, i) => [`q${i}`, NOUL]));
    const ai = answering({
      answers: Object.fromEntries(
        Object.keys(questions).map((id) => [id, { type: "noul", noul: 0.5 }]),
      ),
    });
    const result = await askClef(ai, {}, questions, OPTIONS);
    expect(result.ok).toBe(true);
    expect(result.answers.size).toBe(64);
  });

  test("sends the Clef variant, state, and questions through the AI Gateway", async () => {
    const ai = answering({ answers: { q: { type: "noul", noul: 0.9 } } });
    await askClef(
      ai,
      { spans: ["x"] },
      { q: NOUL },
      {
        timeoutMs: 1_000,
        gatewayMetadata: { scanId: "scan_1", operation: "injection-screen" },
      },
    );

    expect(ai.run).toHaveBeenCalledTimes(1);
    const [model, input, options] = ai.run.mock.calls[0];
    expect(model).toBe(CLEF_MODEL);
    expect(model).toBe("@cf/cloudflare/clef");
    expect(input).toEqual({ model: "clef", state: { spans: ["x"] }, questions: { q: NOUL } });
    expect(options.gateway).toEqual({ id: "drydock-gateway" });
    expect(JSON.parse(options.extraHeaders["cf-aig-metadata"])).toEqual({
      scanId: "scan_1",
      operation: "injection-screen",
    });
    expect(options.extraHeaders["cf-aig-max-attempts"]).toBe("1");
  });

  test("sends empty gateway metadata when the caller passes none", async () => {
    const ai = answering({ answers: { q: { type: "noul", noul: 0.9 } } });
    await askClef(ai, {}, { q: NOUL }, OPTIONS);
    expect(ai.run.mock.calls[0][2].extraHeaders["cf-aig-metadata"]).toBe("{}");
  });

  test("parses noul and score answers and reports input token usage", async () => {
    const ai = answering({
      answers: {
        hazard: { type: "noul", noul: 0.91 },
        severity: { type: "score", score: 1.4, probabilities: [0.1, 0.4, 0.5] },
      },
      usage: { input_tokens: 3_100 },
    });
    const result = await askClef(ai, {}, { hazard: NOUL, severity: SCORE }, OPTIONS);

    expect(result.ok).toBe(true);
    expect(result.answers.get("hazard")).toEqual({ type: "noul", noul: 0.91 });
    expect(result.answers.get("severity")).toEqual({ type: "score", score: 1.4 });
    expect(result.usage).toEqual({ inputTokens: 3_100 });
  });

  test.each([
    ["missing", {}],
    ["not a number", { usage: { input_tokens: "3100" } }],
    ["not finite", { usage: { input_tokens: Infinity } }],
    ["not an object", { usage: 42 }],
  ])("reports unknown usage when it is %s", async (_label, extra) => {
    const ai = answering({ answers: { q: { type: "noul", noul: 0.2 } }, ...extra });
    const result = await askClef(ai, {}, { q: NOUL }, OPTIONS);
    expect(result).toMatchObject({ ok: true, usage: { inputTokens: null } });
  });

  test("ignores answers to questions it did not ask", async () => {
    const ai = answering({
      answers: { q: { type: "noul", noul: 0.2 }, stray: { type: "noul", noul: 7 } },
    });
    const result = await askClef(ai, {}, { q: NOUL }, OPTIONS);
    expect(result.ok).toBe(true);
    expect([...result.answers.keys()]).toEqual(["q"]);
  });

  test.each([0, 1, 2])("accepts a score at level %i", async (score) => {
    const ai = answering({ answers: { s: { type: "score", score } } });
    expect((await askClef(ai, {}, { s: SCORE }, OPTIONS)).ok).toBe(true);
  });

  // A batch is answered whole or not at all: a caller that read a missing
  // hazard probability as absent would treat a dropped question as a confident no.
  test.each([
    ["the body is not an object", null],
    ["answers is missing", { usage: { input_tokens: 1 } }],
    ["answers is an array", { answers: [{ type: "noul", noul: 0.5 }] }],
    ["one answer is missing", { answers: { q: { type: "noul", noul: 0.5 } } }],
    [
      "an answer has the wrong type",
      { answers: { q: { type: "score", score: 0.5 }, s: { type: "score", score: 1 } } },
    ],
    [
      "a probability is above 1",
      { answers: { q: { type: "noul", noul: 1.01 }, s: { type: "score", score: 1 } } },
    ],
    [
      "a probability is negative",
      { answers: { q: { type: "noul", noul: -0.01 }, s: { type: "score", score: 1 } } },
    ],
    [
      "a probability is not a number",
      { answers: { q: { type: "noul", noul: "0.5" }, s: { type: "score", score: 1 } } },
    ],
    [
      "a probability is NaN",
      { answers: { q: { type: "noul", noul: NaN }, s: { type: "score", score: 1 } } },
    ],
    [
      "a score is above the top level",
      { answers: { q: { type: "noul", noul: 0.5 }, s: { type: "score", score: 2.01 } } },
    ],
    [
      "a score is below the bottom level",
      { answers: { q: { type: "noul", noul: 0.5 }, s: { type: "score", score: -0.5 } } },
    ],
    [
      "a score is not finite",
      { answers: { q: { type: "noul", noul: 0.5 }, s: { type: "score", score: Infinity } } },
    ],
    ["an answer is not an object", { answers: { q: 0.5, s: { type: "score", score: 1 } } }],
  ])("drops the whole batch as malformed when %s", async (_label, body) => {
    const ai = answering(body);
    expect(await askClef(ai, {}, { q: NOUL, s: SCORE }, OPTIONS)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  test("collapses a rejected call to failed instead of throwing", async () => {
    const ai = binding(async () => {
      throw new Error("3040: capacity exceeded");
    });
    await expect(askClef(ai, {}, { q: NOUL }, OPTIONS)).resolves.toEqual({
      ok: false,
      reason: "failed",
    });
  });

  test("collapses a binding that throws synchronously to failed", async () => {
    const ai = binding(() => {
      throw new Error("bad input");
    });
    await expect(askClef(ai, {}, { q: NOUL }, OPTIONS)).resolves.toEqual({
      ok: false,
      reason: "failed",
    });
  });

  test("gives up after the caller's budget when the binding never answers", async () => {
    const ai = binding(() => new Promise(() => {}));
    expect(await askClef(ai, {}, { q: NOUL }, { timeoutMs: 5 })).toEqual({
      ok: false,
      reason: "timeout",
    });
  });

  test("a rejection that lands after the timeout is not left unhandled", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const ai = binding(
        () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error("late provider error")), 20);
          }),
      );
      expect(await askClef(ai, {}, { q: NOUL }, { timeoutMs: 5 })).toEqual({
        ok: false,
        reason: "timeout",
      });
      // Outlive the late rejection and the tick Node reports unhandled ones on.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
