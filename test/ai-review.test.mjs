import { afterEach, describe, expect, test, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import {
  AI_FALLBACK_MODEL,
  AI_MODEL,
  AI_MODEL_CANDIDATES,
  AI_REVIEWER_VERSION,
  analyzeWithAi,
  aiGatewayMetadataHeader,
  aiReviewRequestHeaders,
  aiReviewTraceTelemetry,
  displayedAiResult,
  selectModelCandidates,
  traceIsolatedAiBinding,
} from "../server/lib/ai-review";
import {
  buildReviewerSystemPrompt,
  MAX_AGENT_STEPS,
  MAX_AI_FINDINGS,
  normalizeAiReviewEcosystem,
} from "../server/lib/ai-review/contract";
import { computeScanRisk } from "../server/lib/review/risk";

const EMPTY_PACKAGE_JSON_DIFF = {
  name: null,
  previousVersion: null,
  stagedVersion: null,
  scripts: [],
  dependencies: [],
  entrypointsChanged: false,
};

const BASE_OPTIONS = {
  ecosystem: "npm",
  files: [],
  diff: [],
  packageJsonDiff: EMPTY_PACKAGE_JSON_DIFF,
  ruleFindings: [],
  previousVersionAvailable: true,
};

const VALID_REVIEW = {
  risk: "low",
  releaseAssessment: "nothing_unusual",
  summary: "No unusual changes.",
  findings: [],
  requiresManualReview: false,
};

function generateResult(content, finishReason) {
  return {
    content,
    finishReason,
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 10, text: 10, reasoning: 0 },
    },
    warnings: [],
  };
}

function mockModel(doGenerate) {
  return new MockLanguageModelV3({ modelId: "mock-reviewer", doGenerate });
}

afterEach(() => {
  vi.restoreAllMocks();
});

function skipRetryDelay() {
  vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, _timeout, ...args) => {
    if (typeof handler === "function") {
      queueMicrotask(() => handler(...args));
    }
    return 0;
  });
}

// A model that immediately submits a review through the submit_review tool.
function submittingModel(review) {
  return mockModel(async () =>
    generateResult(
      [
        {
          type: "tool-call",
          toolCallId: "submit-1",
          toolName: "submit_review",
          input: JSON.stringify(review),
        },
      ],
      "tool-calls",
    ),
  );
}

// A model that answers in plain text without calling any tool.
function textOnlyModel(text) {
  return mockModel(async () => generateResult([{ type: "text", text }], "stop"));
}

function aiFinding(severity, file) {
  return {
    severity,
    file,
    evidence: `evidence in ${file}`,
    reason: `reason for ${file}`,
    recommendation: "review manually",
  };
}

// Routing invariants only. We deliberately do NOT assert exact prompt copy
// (technique wording, lifecycle-script phrasing, etc.) — that wording is tuned
// often and string-match assertions break with no behavior change. The invariant
// that matters is that each ecosystem routes to its own prompt and does not leak
// the other ecosystem's guidance.
describe("AI review prompt selection", () => {
  test("routes the npm ecosystem to the npm prompt without PyPI leakage", () => {
    const prompt = buildReviewerSystemPrompt("npm");

    expect(prompt).toContain("Ecosystem: npm.");
    expect(prompt).not.toContain("Ecosystem: PyPI.");
  });

  test("routes the pypi ecosystem to the PyPI prompt without npm leakage", () => {
    const prompt = buildReviewerSystemPrompt("pypi");

    expect(prompt).toContain("Ecosystem: PyPI.");
    expect(prompt).not.toContain("optionalDependencies");
  });

  test("routes the vscode ecosystem to the VS Code prompt without npm/PyPI leakage", () => {
    expect(normalizeAiReviewEcosystem("vscode")).toBe("vscode");

    const prompt = buildReviewerSystemPrompt("vscode");

    expect(prompt).toContain("Ecosystem: VS Code extension (VSIX).");
    expect(prompt).not.toContain("Ecosystem: npm.");
    expect(prompt).not.toContain("Ecosystem: PyPI.");
    expect(prompt).not.toContain("Ecosystem: generic package release.");
  });

  test("routes browser extensions to WebExtension-specific review guidance", () => {
    expect(normalizeAiReviewEcosystem("browser")).toBe("browser");
    const prompt = buildReviewerSystemPrompt("browser");
    expect(prompt).toContain("WebExtension ZIP/XPI");
    expect(prompt).toContain("externally_connectable");
    expect(prompt).not.toContain("Ecosystem: PyPI");
  });

  test("falls back to generic package guidance for unknown adapters", () => {
    expect(normalizeAiReviewEcosystem("rubygems")).toBe("generic");
    expect(normalizeAiReviewEcosystem(undefined)).toBe("generic");
    expect(buildReviewerSystemPrompt("rubygems")).toContain("Ecosystem: generic package release.");
  });
});

describe("ai review orchestration", () => {
  test("pins the reviewer model order", () => {
    expect(AI_MODEL).toBe("@cf/zai-org/glm-5.3-flash");
    expect(AI_FALLBACK_MODEL).toBe("@cf/moonshotai/kimi-k2.7-code");
    expect(AI_MODEL_CANDIDATES).toEqual([AI_MODEL, AI_FALLBACK_MODEL]);
  });
  test("uses GLM first for a clean low-signal release", () => {
    expect(selectModelCandidates(BASE_OPTIONS)).toEqual([AI_MODEL, AI_FALLBACK_MODEL]);
  });

  test("keeps the strong model first when deterministic findings are present", () => {
    const options = {
      ...BASE_OPTIONS,
      ruleFindings: [aiFinding("high", "package.json")],
      diff: [
        {
          path: "src/index.js",
          status: "added",
          stagedSize: 10,
          stagedSha256: "sha-1",
          flags: [],
        },
      ],
    };

    expect(selectModelCandidates(options)).toEqual([AI_FALLBACK_MODEL, AI_MODEL]);
  });

  test("keeps the strong model first when lifecycle scripts change", () => {
    const options = {
      ...BASE_OPTIONS,
      packageJsonDiff: {
        ...EMPTY_PACKAGE_JSON_DIFF,
        scripts: [{ key: "postinstall", status: "added", staged: "node install.js" }],
      },
      diff: [
        {
          path: "src/index.js",
          status: "added",
          stagedSize: 10,
          stagedSha256: "sha-1",
          flags: [],
        },
      ],
    };

    expect(selectModelCandidates(options)).toEqual([AI_FALLBACK_MODEL, AI_MODEL]);
  });

  test("keeps the strong model first when dependencies change", () => {
    const options = {
      ...BASE_OPTIONS,
      packageJsonDiff: {
        ...EMPTY_PACKAGE_JSON_DIFF,
        dependencies: [{ key: "left-pad", status: "added", staged: "^1.0.0" }],
      },
      diff: [
        {
          path: "src/index.js",
          status: "added",
          stagedSize: 10,
          stagedSha256: "sha-1",
          flags: [],
        },
      ],
    };

    expect(selectModelCandidates(options)).toEqual([AI_FALLBACK_MODEL, AI_MODEL]);
  });

  test("keeps the strong model first when entrypoints change", () => {
    const options = {
      ...BASE_OPTIONS,
      packageJsonDiff: {
        ...EMPTY_PACKAGE_JSON_DIFF,
        entrypointsChanged: true,
      },
      diff: [
        {
          path: "src/index.js",
          status: "added",
          stagedSize: 10,
          stagedSha256: "sha-1",
          flags: [],
        },
      ],
    };

    expect(selectModelCandidates(options)).toEqual([AI_FALLBACK_MODEL, AI_MODEL]);
  });

  test("keeps the strong model first when no previous version is available", () => {
    const options = {
      ...BASE_OPTIONS,
      previousVersionAvailable: false,
      diff: [
        {
          path: "src/index.js",
          status: "added",
          stagedSize: 10,
          stagedSha256: "sha-1",
          flags: [],
        },
      ],
    };

    expect(selectModelCandidates(options)).toEqual([AI_FALLBACK_MODEL, AI_MODEL]);
  });

  test("uses GLM first for a medium-signal release", () => {
    const options = {
      ...BASE_OPTIONS,
      ruleFindings: [aiFinding("medium", "src/index.js")],
    };

    expect(selectModelCandidates(options)).toEqual(AI_MODEL_CANDIDATES);
  });

  test("keeps AI Gateway metadata within the five-field log limit", () => {
    expect(
      JSON.parse(
        aiGatewayMetadataHeader(
          {
            ...BASE_OPTIONS,
            scanId: "scan_123",
            stageId: "stage_123",
            organizationId: "org_123",
          },
          AI_MODEL,
          2,
        ),
      ),
    ).toEqual({
      scanId: "scan_123",
      organizationId: "org_123",
      ecosystem: "npm",
      attempt: 2,
      stageId: "stage_123",
    });
  });

  test("keeps Gateway logs metadata-only and disables hidden retries", () => {
    expect(aiReviewRequestHeaders({}, BASE_OPTIONS, AI_MODEL, 1)).toMatchObject({
      "cf-aig-collect-log-payload": "false",
      "cf-aig-max-attempts": "1",
    });
  });

  test("Agent Trace metadata is versioned and excludes review-record identifiers", () => {
    const telemetry = aiReviewTraceTelemetry(
      {
        ...BASE_OPTIONS,
        scanId: "scan_private",
        stageId: "stage_private",
        organizationId: "org_private",
      },
      "trace_random",
    );

    expect(telemetry).toEqual({
      runtimeContext: {
        agentId: "drydock-release-reviewer",
        agentVersion: AI_REVIEWER_VERSION,
        conversationId: "trace_random",
        ecosystem: "npm",
      },
      telemetry: {
        functionId: "drydock-release-reviewer",
        includeRuntimeContext: {
          agentId: true,
          agentVersion: true,
          conversationId: true,
          ecosystem: true,
        },
        recordInputs: false,
        recordOutputs: false,
      },
    });
    expect(JSON.stringify(telemetry)).not.toMatch(/scan_private|stage_private|org_private/);
  });

  test("hides the AI Gateway log correlation handle from Agent Traces", async () => {
    const run = vi.fn(async () => ({ response: "ok" }));
    const binding = traceIsolatedAiBinding({
      aiGatewayLogId: "gateway-log-private",
      run,
    });

    expect("aiGatewayLogId" in binding).toBe(false);
    expect(binding.aiGatewayLogId).toBeUndefined();
    await binding.run("@cf/test/model", { prompt: "hello" }, { gateway: { id: "test" } });
    expect(run).toHaveBeenCalledWith(
      "@cf/test/model",
      { prompt: "hello" },
      { gateway: { id: "test" } },
    );
  });

  test("a submit_review tool call produces a complete review and records the model", async () => {
    const { review: ai, usage } = await analyzeWithAi(
      {},
      "mock-reviewer",
      BASE_OPTIONS,
      submittingModel(VALID_REVIEW),
    );

    expect(ai.status).toBe("complete");
    expect(ai.risk).toBe("low");
    expect(ai.releaseAssessment).toBe("nothing_unusual");
    expect(ai.summary).toBe("No unusual changes.");
    expect(ai.model).toBe("mock-reviewer");
    expect(ai.reviewerVersion).toBe(AI_REVIEWER_VERSION);
    expect(computeScanRisk([], ai)).toBe("low");

    // Usage telemetry is captured from the generateText result.
    expect(usage).not.toBeNull();
    expect(usage.steps).toBe(1);
    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(10);
  });

  test("a high/critical finding raises package risk", async () => {
    const { review: ai } = await analyzeWithAi(
      {},
      "mock-reviewer",
      BASE_OPTIONS,
      submittingModel({
        risk: "high",
        releaseAssessment: "suspicious",
        summary: "Install hook reaches the network.",
        findings: [aiFinding("high", "package/scripts/postinstall.js")],
        requiresManualReview: true,
      }),
    );

    expect(ai.status).toBe("complete");
    expect(ai.risk).toBe("high");
    expect(ai.findings).toHaveLength(1);
    expect(computeScanRisk([], ai)).toBe("high");
  });

  test("keeps only the top critical/high findings, most severe first", async () => {
    const { review: ai } = await analyzeWithAi(
      {},
      "mock-reviewer",
      BASE_OPTIONS,
      submittingModel({
        risk: "critical",
        releaseAssessment: "blocked",
        summary: "Multiple issues.",
        findings: [
          aiFinding("high", "package/a.js"),
          aiFinding("medium", "package/b.js"),
          aiFinding("critical", "package/c.js"),
          aiFinding("low", "package/d.js"),
          aiFinding("high", "package/e.js"),
          aiFinding("critical", "package/f.js"),
          aiFinding("high", "package/g.js"),
          aiFinding("high", "package/h.js"),
          aiFinding("info", "package/i.js"),
        ],
        requiresManualReview: true,
      }),
    );

    expect(ai.status).toBe("complete");
    // medium/low/info dropped; capped at MAX_AI_FINDINGS; critical before high.
    expect(ai.findings).toHaveLength(MAX_AI_FINDINGS);
    expect(
      ai.findings.every(
        (finding) => finding.severity === "critical" || finding.severity === "high",
      ),
    ).toBe(true);
    expect(ai.findings.slice(0, 2).map((finding) => finding.severity)).toEqual([
      "critical",
      "critical",
    ]);
    expect(ai.findings.map((finding) => finding.file)).toEqual([
      "package/c.js",
      "package/f.js",
      "package/a.js",
      "package/e.js",
      "package/g.js",
      "package/h.js",
    ]);
  });

  test("keeps the strong model first for medium-severity obfuscation", () => {
    const options = {
      ...BASE_OPTIONS,
      ruleFindings: [{ ...aiFinding("medium", "src/index.js"), obfuscated: true }],
      diff: [
        {
          path: "src/index.js",
          status: "modified",
          stagedSize: 10,
          stagedSha256: "sha-1",
          flags: [],
        },
      ],
    };

    expect(selectModelCandidates(options)).toEqual([AI_FALLBACK_MODEL, AI_MODEL]);
  });

  test("a complete review without evidence does not raise package risk", async () => {
    const { review: ai } = await analyzeWithAi(
      {},
      "mock-reviewer",
      BASE_OPTIONS,
      submittingModel({
        ...VALID_REVIEW,
        risk: "medium",
        releaseAssessment: "review_recommended",
      }),
    );

    expect(ai.status).toBe("complete");
    expect(computeScanRisk([], ai)).toBe("low");
  });

  test("a review returned as JSON text without a tool call still completes", async () => {
    const { review: ai } = await analyzeWithAi(
      {},
      "mock-reviewer",
      BASE_OPTIONS,
      textOnlyModel(JSON.stringify(VALID_REVIEW)),
    );

    expect(ai.status).toBe("complete");
    expect(ai.releaseAssessment).toBe("nothing_unusual");
  });

  test("non-JSON text without a tool call fails safe: invalid review escalates to manual review", async () => {
    const { review: ai } = await analyzeWithAi(
      {},
      "mock-reviewer",
      BASE_OPTIONS,
      textOnlyModel("I could not finish the review."),
    );

    expect(ai.status).toBe("invalid");
    expect(ai.releaseAssessment).toBe("not_assessed");
    expect(computeScanRisk([], ai)).toBe("medium");
  });

  test("an incomplete submission fails safe: invalid review escalates to manual review", async () => {
    const { review: ai } = await analyzeWithAi(
      {},
      "mock-reviewer",
      BASE_OPTIONS,
      textOnlyModel(JSON.stringify({ findings: [], requiresManualReview: false })),
    );

    expect(ai.status).toBe("invalid");
    expect(ai.releaseAssessment).toBe("not_assessed");
    expect(computeScanRisk([], ai)).toBe("medium");
  });

  test("a model error fails safe: unavailable review escalates to manual review", async () => {
    // A non-transient error (not capacity/overload) is not retried — retrying a
    // deterministic failure would just burn budget — so the model is hit once.
    let calls = 0;
    const { review: ai, usage } = await analyzeWithAi(
      {},
      "mock-reviewer",
      BASE_OPTIONS,
      mockModel(async () => {
        calls += 1;
        throw new Error("model exploded");
      }),
    );

    expect(calls).toBe(1);
    expect(ai.status).toBe("unavailable");
    expect(ai.releaseAssessment).toBe("not_assessed");
    expect(ai.model).toBe("mock-reviewer");
    expect(computeScanRisk([], ai)).toBe("medium");
    // No generateText result on the error path, so there is no usage to report.
    expect(usage).toBeNull();
  });

  test("a transient capacity error is retried and the review completes", async () => {
    skipRetryDelay();
    // Reproduces the reported 3040 failure: the first call hits a capacity
    // rejection that the model itself asks us to retry; the retry succeeds.
    let calls = 0;
    const flakyModel = mockModel(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("3040: Capacity temporarily exceeded, please try again.");
      }
      return generateResult(
        [
          {
            type: "tool-call",
            toolCallId: "submit-1",
            toolName: "submit_review",
            input: JSON.stringify(VALID_REVIEW),
          },
        ],
        "tool-calls",
      );
    });

    const { review: ai } = await analyzeWithAi({}, "mock-reviewer", BASE_OPTIONS, flakyModel);

    expect(calls).toBe(2);
    expect(ai.status).toBe("complete");
    expect(ai.summary).toBe("No unusual changes.");
  });

  test("a request timeout moves directly to the fallback model", async () => {
    const calls = new Map();
    const modelFactory = (model) =>
      mockModel(async () => {
        calls.set(model, (calls.get(model) ?? 0) + 1);
        if (model === "primary-reviewer") {
          throw new Error("AiError: AiError: Request timeout (ca4ebee2)");
        }
        return generateResult(
          [
            {
              type: "tool-call",
              toolCallId: "submit-1",
              toolName: "submit_review",
              input: JSON.stringify(VALID_REVIEW),
            },
          ],
          "tool-calls",
        );
      });

    const { review: ai } = await analyzeWithAi(
      {},
      ["primary-reviewer", "fallback-reviewer"],
      BASE_OPTIONS,
      modelFactory,
    );

    expect(calls.get("primary-reviewer")).toBe(1);
    expect(calls.get("fallback-reviewer")).toBe(1);
    expect(ai.status).toBe("complete");
    expect(ai.model).toBe("fallback-reviewer");
  });

  test("a typed Workers AI timeout moves directly to the fallback model", async () => {
    const calls = new Map();
    const modelFactory = (model) =>
      mockModel(async () => {
        calls.set(model, (calls.get(model) ?? 0) + 1);
        if (model === "primary-reviewer") {
          throw Object.assign(new Error("binding failed"), {
            statusCode: 408,
            data: { workersAIErrorCode: 3007 },
          });
        }
        return generateResult(
          [
            {
              type: "tool-call",
              toolCallId: "submit-1",
              toolName: "submit_review",
              input: JSON.stringify(VALID_REVIEW),
            },
          ],
          "tool-calls",
        );
      });

    const { review: ai } = await analyzeWithAi(
      {},
      ["primary-reviewer", "fallback-reviewer"],
      BASE_OPTIONS,
      modelFactory,
    );

    expect(calls.get("primary-reviewer")).toBe(1);
    expect(calls.get("fallback-reviewer")).toBe(1);
    expect(ai.model).toBe("fallback-reviewer");
  });

  test("a REST-shaped 3040 response is retried as capacity before falling back", async () => {
    skipRetryDelay();
    let calls = 0;
    const flakyModel = mockModel(async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(
          new Error(
            'Workers AI API error (429 Too Many Requests): {"errors":[{"code":3040,"message":"No more data centers to forward the request to"}]}',
          ),
          { statusCode: 429 },
        );
      }
      return generateResult(
        [
          {
            type: "tool-call",
            toolCallId: "submit-1",
            toolName: "submit_review",
            input: JSON.stringify(VALID_REVIEW),
          },
        ],
        "tool-calls",
      );
    });

    const { review: ai } = await analyzeWithAi({}, "mock-reviewer", BASE_OPTIONS, flakyModel);

    expect(calls).toBe(2);
    expect(ai.status).toBe("complete");
  });

  test("a persistent provider 500 retries once before falling back", async () => {
    skipRetryDelay();
    const calls = new Map();
    const modelFactory = (model) =>
      mockModel(async () => {
        calls.set(model, (calls.get(model) ?? 0) + 1);
        if (model === "primary-reviewer") {
          throw Object.assign(new Error("Workers AI API error (500 Internal Server Error)"), {
            statusCode: 500,
          });
        }
        return generateResult(
          [
            {
              type: "tool-call",
              toolCallId: "submit-1",
              toolName: "submit_review",
              input: JSON.stringify(VALID_REVIEW),
            },
          ],
          "tool-calls",
        );
      });

    const { review: ai } = await analyzeWithAi(
      {},
      ["primary-reviewer", "fallback-reviewer"],
      BASE_OPTIONS,
      modelFactory,
    );

    expect(calls.get("primary-reviewer")).toBe(2);
    expect(calls.get("fallback-reviewer")).toBe(1);
    expect(ai.status).toBe("complete");
    expect(ai.model).toBe("fallback-reviewer");
  });

  test("a gateway 504 moves directly to the fallback model", async () => {
    const calls = new Map();
    const modelFactory = (model) =>
      mockModel(async () => {
        calls.set(model, (calls.get(model) ?? 0) + 1);
        if (model === "primary-reviewer") {
          throw Object.assign(new Error("AI Gateway request timed out"), { statusCode: 504 });
        }
        return generateResult(
          [
            {
              type: "tool-call",
              toolCallId: "submit-1",
              toolName: "submit_review",
              input: JSON.stringify(VALID_REVIEW),
            },
          ],
          "tool-calls",
        );
      });

    const { review: ai } = await analyzeWithAi(
      {},
      ["primary-reviewer", "fallback-reviewer"],
      BASE_OPTIONS,
      modelFactory,
    );

    expect(calls.get("primary-reviewer")).toBe(1);
    expect(calls.get("fallback-reviewer")).toBe(1);
    expect(ai.status).toBe("complete");
    expect(ai.model).toBe("fallback-reviewer");
  });

  test("a rate limit moves directly to the fallback model", async () => {
    const calls = new Map();
    const modelFactory = (model) =>
      mockModel(async () => {
        calls.set(model, (calls.get(model) ?? 0) + 1);
        if (model === "primary-reviewer") throw new Error("429: too many requests");
        return generateResult(
          [
            {
              type: "tool-call",
              toolCallId: "submit-1",
              toolName: "submit_review",
              input: JSON.stringify(VALID_REVIEW),
            },
          ],
          "tool-calls",
        );
      });

    const { review: ai } = await analyzeWithAi(
      {},
      ["primary-reviewer", "fallback-reviewer"],
      BASE_OPTIONS,
      modelFactory,
    );

    expect(calls.get("primary-reviewer")).toBe(1);
    expect(calls.get("fallback-reviewer")).toBe(1);
    expect(ai.model).toBe("fallback-reviewer");
  });

  test("a persistent capacity error exhausts retries and fails safe to unavailable", async () => {
    skipRetryDelay();
    let calls = 0;
    const downModel = mockModel(async () => {
      calls += 1;
      throw new Error("3040: Capacity temporarily exceeded, please try again.");
    });

    const { review: ai } = await analyzeWithAi({}, "mock-reviewer", BASE_OPTIONS, downModel);

    // Retried up to the attempt cap before degrading, not retried forever.
    expect(calls).toBe(2);
    expect(ai.status).toBe("unavailable");
    expect(ai.summary).toContain("Capacity temporarily exceeded");
    expect(computeScanRisk([], ai)).toBe("medium");
  });

  test("a persistent capacity error falls back to the secondary reviewer", async () => {
    skipRetryDelay();
    const calls = new Map();
    const modelFactory = (model) =>
      mockModel(async () => {
        calls.set(model, (calls.get(model) ?? 0) + 1);
        if (model === "primary-reviewer") {
          throw new Error("3040: Capacity temporarily exceeded, please try again.");
        }
        return generateResult(
          [
            {
              type: "tool-call",
              toolCallId: "submit-1",
              toolName: "submit_review",
              input: JSON.stringify(VALID_REVIEW),
            },
          ],
          "tool-calls",
        );
      });

    const { review: ai } = await analyzeWithAi(
      {},
      ["primary-reviewer", "fallback-reviewer"],
      BASE_OPTIONS,
      modelFactory,
    );

    expect(calls.get("primary-reviewer")).toBe(2);
    expect(calls.get("fallback-reviewer")).toBe(1);
    expect(ai.status).toBe("complete");
    expect(ai.model).toBe("fallback-reviewer");
  });

  test("an invalid review moves to the fallback model without retrying the same model", async () => {
    const calls = new Map();
    const modelFactory = (model) =>
      mockModel(async () => {
        calls.set(model, (calls.get(model) ?? 0) + 1);
        if (model === "primary-reviewer") {
          return generateResult([{ type: "text", text: "review incomplete" }], "stop");
        }
        return generateResult(
          [
            {
              type: "tool-call",
              toolCallId: "submit-1",
              toolName: "submit_review",
              input: JSON.stringify(VALID_REVIEW),
            },
          ],
          "tool-calls",
        );
      });

    const { review: ai } = await analyzeWithAi(
      {},
      ["primary-reviewer", "fallback-reviewer"],
      BASE_OPTIONS,
      modelFactory,
    );

    expect(calls.get("primary-reviewer")).toBe(1);
    expect(calls.get("fallback-reviewer")).toBe(1);
    expect(ai.status).toBe("complete");
    expect(ai.model).toBe("fallback-reviewer");
  });

  test("records anonymous per-model attempt outcomes and fallback actions", async () => {
    const points = [];
    const env = {
      PRODUCT_ANALYTICS: { writeDataPoint: (point) => points.push(point) },
    };
    const modelFactory = (model) =>
      model === "primary-reviewer"
        ? mockModel(async () => {
            throw new Error("429: too many requests");
          })
        : submittingModel(VALID_REVIEW);

    await analyzeWithAi(
      env,
      ["primary-reviewer", "fallback-reviewer"],
      {
        ...BASE_OPTIONS,
        organizationId: "org_private",
        scanId: "scan_private",
      },
      modelFactory,
    );

    expect(points).toHaveLength(2);
    expect(points.map((point) => point.blobs.slice(2))).toEqual([
      ["", "npm", "rate_limited", "fallback", "primary-reviewer", AI_REVIEWER_VERSION],
      ["", "npm", "complete", "done", "fallback-reviewer", AI_REVIEWER_VERSION],
    ]);
    expect(JSON.stringify(points)).not.toMatch(/org_private|scan_private/);
  });

  test("records usage from completed steps when a later provider call falls back", async () => {
    const points = [];
    const env = {
      PRODUCT_ANALYTICS: { writeDataPoint: (point) => points.push(point) },
    };
    let primaryCalls = 0;
    const modelFactory = (model) =>
      model === "primary-reviewer"
        ? mockModel(async () => {
            primaryCalls += 1;
            if (primaryCalls > 1) throw new Error("429: too many requests");
            return generateResult(
              [
                {
                  type: "tool-call",
                  toolCallId: "read-1",
                  toolName: "read",
                  input: JSON.stringify({ paths: ["index.js"] }),
                },
              ],
              "tool-calls",
            );
          })
        : submittingModel(VALID_REVIEW);

    await analyzeWithAi(env, ["primary-reviewer", "fallback-reviewer"], BASE_OPTIONS, modelFactory);

    expect(points).toHaveLength(2);
    expect(points[0].blobs.slice(4)).toEqual([
      "rate_limited",
      "fallback",
      "primary-reviewer",
      AI_REVIEWER_VERSION,
    ]);
    expect(points[0].doubles.slice(1)).toEqual([1, 1, 10, 0, 10, 20]);
  });

  test("a complete submission slightly over the summary bound is clamped, not discarded", async () => {
    // Reproduces the reported failure: validation used to reject the whole call
    // over a few-char overage, dropping a critical finding and collapsing to low.
    const overLongSummary = `${"word ".repeat(310)}tail.`;
    const { review: ai } = await analyzeWithAi(
      {},
      "mock-reviewer",
      BASE_OPTIONS,
      submittingModel({
        risk: "high",
        releaseAssessment: "suspicious",
        summary: overLongSummary,
        findings: [aiFinding("critical", "package.json")],
        requiresManualReview: true,
      }),
    );

    expect(ai.status).toBe("complete");
    expect(ai.summary.length).toBeLessThanOrEqual(1500);
    expect(ai.findings).toHaveLength(1);
    expect(ai.findings[0].severity).toBe("critical");
    expect(computeScanRisk([], ai)).toBe("high");
  });

  test("an over-long summary is cut on a boundary and marked, never mid-word", async () => {
    // The reported UI bug: a 1000-char hard slice ended the rendered summary at
    // "I searched the availabl", which reads as the reviewer crashing rather
    // than as a system cap.
    const sentence = "The prepare script now runs husky and playwright install chromium. ";
    const { review: ai } = await analyzeWithAi(
      {},
      "mock-reviewer",
      BASE_OPTIONS,
      submittingModel({
        risk: "medium",
        releaseAssessment: "review_recommended",
        summary: `${sentence.repeat(40)}I searched the available evidence.`,
        findings: [],
        requiresManualReview: true,
      }),
    );

    expect(ai.status).toBe("complete");
    expect(ai.summary.length).toBeLessThanOrEqual(1500);
    expect(ai.summary.endsWith(" …")).toBe(true);
    // Boundary-aligned: the retained text ends at a whole sentence, and nothing
    // before the marker is a severed word.
    expect(ai.summary).toMatch(/chromium\. …$/);
  });

  test("prose with no whitespace to break on still clamps within bounds", async () => {
    const { review: ai } = await analyzeWithAi(
      {},
      "mock-reviewer",
      BASE_OPTIONS,
      submittingModel({
        risk: "high",
        releaseAssessment: "suspicious",
        summary: "A".repeat(4000),
        findings: [
          {
            ...aiFinding("critical", "package.json"),
            evidence: "B".repeat(2000),
            reason: "C".repeat(2000),
            recommendation: "D".repeat(2000),
          },
        ],
        requiresManualReview: true,
      }),
    );

    expect(ai.status).toBe("complete");
    expect(ai.summary.length).toBeLessThanOrEqual(1500);
    expect(ai.findings[0].evidence.length).toBeLessThanOrEqual(600);
    expect(ai.findings[0].reason.length).toBeLessThanOrEqual(600);
    expect(ai.findings[0].recommendation.length).toBeLessThanOrEqual(400);
  });

  test("an invalid submit_review does not end the loop; the model retries and completes", async () => {
    // First attempt has a bad severity enum (unrepairable); the loop must keep
    // going instead of stopping on the call's presence. Second attempt is valid.
    let calls = 0;
    const retryingModel = mockModel(async () => {
      calls += 1;
      const review =
        calls === 1
          ? {
              risk: "high",
              releaseAssessment: "suspicious",
              summary: "first try",
              findings: [{ ...aiFinding("high", "package/a.js"), severity: "BOGUS" }],
              requiresManualReview: true,
            }
          : {
              risk: "high",
              releaseAssessment: "suspicious",
              summary: "second try",
              findings: [aiFinding("high", "package/a.js")],
              requiresManualReview: true,
            };
      return generateResult(
        [
          {
            type: "tool-call",
            toolCallId: `submit-${calls}`,
            toolName: "submit_review",
            input: JSON.stringify(review),
          },
        ],
        "tool-calls",
      );
    });

    const { review: ai } = await analyzeWithAi({}, "mock-reviewer", BASE_OPTIONS, retryingModel);

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(ai.status).toBe("complete");
    expect(ai.summary).toBe("second try");
    expect(computeScanRisk([], ai)).toBe("high");
  });

  test("the final step of the budget restricts the toolset and forces submit_review", async () => {
    // A model that keeps gathering evidence forever. Without the forced final
    // step the whole run's spend would degrade to an `invalid` fallback.
    const stepCalls = [];
    const stallingModel = mockModel(async (options) => {
      stepCalls.push({
        toolChoice: options.toolChoice,
        toolNames: (options.tools ?? []).map((tool) => tool.name),
      });
      if (options.toolChoice?.type === "tool" && options.toolChoice.toolName === "submit_review") {
        return generateResult(
          [
            {
              type: "tool-call",
              toolCallId: `submit-${stepCalls.length}`,
              toolName: "submit_review",
              input: JSON.stringify(VALID_REVIEW),
            },
          ],
          "tool-calls",
        );
      }
      return generateResult(
        [
          {
            type: "tool-call",
            toolCallId: `read-${stepCalls.length}`,
            toolName: "read",
            input: JSON.stringify({ paths: ["index.js"] }),
          },
        ],
        "tool-calls",
      );
    });

    const { review: ai, usage } = await analyzeWithAi(
      {},
      "mock-reviewer",
      BASE_OPTIONS,
      stallingModel,
    );

    expect(usage.steps).toBe(MAX_AGENT_STEPS);
    for (const call of stepCalls.slice(0, -1)) {
      expect(call.toolChoice?.type ?? "auto").not.toBe("tool");
    }
    const finalCall = stepCalls.at(-1);
    expect(finalCall.toolChoice).toEqual({ type: "tool", toolName: "submit_review" });
    expect(finalCall.toolNames).toEqual(["submit_review"]);
    expect(ai.status).toBe("complete");
    expect(ai.releaseAssessment).toBe("nothing_unusual");
  });
});

describe("displayedAiResult", () => {
  test("returns null when no review is provided", () => {
    expect(displayedAiResult(null)).toBeNull();
    expect(displayedAiResult(undefined)).toBeNull();
  });

  test("invalid status produces an unavailable result that hides fallback risk/assessment", () => {
    const result = displayedAiResult({
      status: "invalid",
      risk: "low",
      releaseAssessment: "not_assessed",
      summary: "Assistant returned non-JSON output.",
      findings: [],
      requiresManualReview: false,
      model: "test-model",
    });
    expect(result).toEqual({
      kind: "unavailable",
      status: "invalid",
      model: "test-model",
      summary: "Assistant returned non-JSON output.",
    });
    expect(result).not.toHaveProperty("risk");
    expect(result).not.toHaveProperty("releaseAssessment");
  });

  test("unavailable status produces an unavailable result", () => {
    const result = displayedAiResult({
      status: "unavailable",
      risk: "low",
      releaseAssessment: "not_assessed",
      summary: "AI review is disabled.",
      findings: [],
      requiresManualReview: false,
      model: null,
    });
    expect(result).toEqual({
      kind: "unavailable",
      status: "unavailable",
      model: null,
      summary: "AI review is disabled.",
    });
  });

  test("complete review exposes risk/assessment", () => {
    const result = displayedAiResult({
      status: "complete",
      risk: "medium",
      releaseAssessment: "review_recommended",
      summary: "Network behavior needs review.",
      findings: [
        {
          severity: "medium",
          file: "package/index.js",
          evidence: "fetch('https://example.com')",
          reason: "outbound network call",
          recommendation: "review manually",
        },
      ],
      requiresManualReview: true,
      model: "test-model",
    });
    expect(result).toEqual({
      kind: "complete",
      model: "test-model",
      summary: "Network behavior needs review.",
      risk: "medium",
      releaseAssessment: "review_recommended",
      findings: [
        {
          severity: "medium",
          file: "package/index.js",
          evidence: "fetch('https://example.com')",
          reason: "outbound network call",
          recommendation: "review manually",
        },
      ],
      requiresManualReview: true,
    });
  });

  test("complete review with not_assessed assessment is treated as unavailable (defensive)", () => {
    const result = displayedAiResult({
      status: "complete",
      risk: "low",
      releaseAssessment: "not_assessed",
      summary: "Stored without an assessment.",
      findings: [],
      requiresManualReview: false,
      model: "test-model",
    });
    expect(result).toEqual({
      kind: "unavailable",
      status: "invalid",
      model: "test-model",
      summary: "Stored without an assessment.",
    });
  });
});

describe("computeScanRisk fail-safe for incomplete AI reviews", () => {
  const incomplete = (status, model) => ({
    status,
    risk: "low",
    releaseAssessment: "not_assessed",
    summary: status === "unavailable" ? "AI review is disabled." : "Could not complete.",
    findings: [],
    requiresManualReview: false,
    model,
  });

  test("a disabled review (no model) stays neutral and keeps the deterministic verdict", () => {
    // AI review off for the org: the fallback carries model === null and must
    // not escalate, or every flag-off scan would force manual review.
    expect(computeScanRisk([], incomplete("unavailable", null))).toBe("low");
    expect(computeScanRisk([{ severity: "high" }], incomplete("unavailable", null))).toBe("high");
  });

  test("an attempted-but-failed review (model present) escalates to manual review", () => {
    expect(computeScanRisk([], incomplete("unavailable", "mock-reviewer"))).toBe("medium");
    expect(computeScanRisk([], incomplete("invalid", "mock-reviewer"))).toBe("medium");
    // Escalation only raises the floor; a higher deterministic risk still wins.
    expect(
      computeScanRisk([{ severity: "critical" }], incomplete("invalid", "mock-reviewer")),
    ).toBe("critical");
  });
});
