import { describe, expect, test } from "vitest";
import {
  describeSetupDraftFailure,
  setupDraftFailureResponse,
} from "../server/lib/github-app/setup-draft-errors";

const PRIVATE_EVIDENCE = "PRIVATE_WORKFLOW npm publish --token=secret-value Bearer private-token";

describe("publisher draft failure diagnostics", () => {
  test.each([
    [{ name: "TimeoutError", code: 23 }, "timeout"],
    [{ name: "AbortError", code: 20 }, "timeout"],
    [{ name: "AI_APICallError", cause: { name: "TimeoutError" } }, "timeout"],
    [{ name: "AI_APICallError", data: { workersAIErrorCode: 3008 } }, "timeout"],
    [{ name: "AI_NoObjectGeneratedError", finishReason: "length" }, "invalid_response"],
    [{ name: "ZodError" }, "invalid_response"],
    [{ statusCode: 429 }, "rate_limited"],
    [{ data: { workersAIErrorCode: "3036" } }, "rate_limited"],
    [{ statusCode: 503 }, "capacity"],
    [{ code: 3040 }, "capacity"],
    [{ statusCode: 429, data: { workersAIErrorCode: 3040 } }, "capacity"],
    [{ statusCode: 500 }, "provider_unavailable"],
    [{ isRetryable: true }, "provider_unavailable"],
    [{ statusCode: 403 }, "provider_rejected"],
    [new Error(PRIVATE_EVIDENCE), "unknown"],
  ])("classifies structured failure %j as %s", (error, category) => {
    expect(describeSetupDraftFailure(error).category).toBe(category);
  });
  test("native timeout DOMException code23 is not a provider code", () => {
    const failure = describeSetupDraftFailure(new DOMException(PRIVATE_EVIDENCE, "TimeoutError"));
    expect(failure).toEqual({ category: "timeout" });
    expect(setupDraftFailureResponse(failure.category)).toMatchObject({
      code: "setup_ai_timeout",
      status: 504,
    });
  });
  test("emits only allowed scalars even when every SDK error payload contains credentials and source", () => {
    const error = {
      name: "AI_NoObjectGeneratedError",
      message: PRIVATE_EVIDENCE,
      text: PRIVATE_EVIDENCE,
      response: { body: PRIVATE_EVIDENCE },
      requestBodyValues: { workflow: PRIVATE_EVIDENCE },
      cause: { message: PRIVATE_EVIDENCE, data: PRIVATE_EVIDENCE },
      data: { workersAIErrorCode: 3006, credential: PRIVATE_EVIDENCE },
      statusCode: 400,
      finishReason: "length",
    };
    const failure = describeSetupDraftFailure(error);
    expect(failure).toEqual({
      category: "invalid_response",
      statusCode: 400,
      providerCode: 3006,
      finishReason: "length",
    });
    expect(JSON.stringify(failure)).not.toContain(PRIVATE_EVIDENCE);
    expect(JSON.stringify(setupDraftFailureResponse(failure.category))).not.toContain(
      PRIVATE_EVIDENCE,
    );
  });
  test("does not read raw error message or arbitrary toString implementations", () => {
    const error = {
      name: {
        toString() {
          throw new Error("must not coerce unknown error names");
        },
      },
      get message() {
        throw new Error("must not read raw messages");
      },
      finishReason: PRIVATE_EVIDENCE,
      statusCode: PRIVATE_EVIDENCE,
      code: 23,
    };
    expect(describeSetupDraftFailure(error)).toEqual({ category: "unknown" });
  });
  test("returns distinct actionable timeout, invalid-response and temporary-provider messages", () => {
    expect(setupDraftFailureResponse("timeout")).toMatchObject({
      code: "setup_ai_timeout",
      error: expect.stringContaining("timed out"),
      status: 504,
    });
    expect(setupDraftFailureResponse("invalid_response")).toMatchObject({
      code: "setup_ai_invalid_response",
      status: 502,
    });
    expect(setupDraftFailureResponse("capacity")).toMatchObject({
      code: "setup_ai_temporarily_unavailable",
      status: 503,
    });
    expect(setupDraftFailureResponse("provider_rejected")).toMatchObject({
      code: "setup_ai_provider_rejected",
      status: 503,
    });
  });
});
