// Detection eval harness.
//
// This is NOT the golden corpus test (test/security-corpus*.test.mjs). The
// golden tests assert exact rule output and protect against regressions. This
// harness measures detection *quality*: recall per threat class, false-positive
// rate on benign hard-negatives, and how much detection survives evasion.
//
// It reuses the real detection code paths so it can never drift from production:
//   - npm:  createPackageDiff + deterministicFindings + packageJsonDiffFindings
//   - pypi: createPyPiReleaseCandidateReview
//   - atpm: atpmRecordFindings
//
// See docs/detection-eval.md for the design and the fixture v2 schema.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeRisk,
  createPackageDiff,
  DETERMINISTIC_RULES_VERSION,
  deterministicFindings,
  packageJsonDiffFindings,
  summarizePackageJsonDiff,
} from "../../server/lib/review";
import {
  createPyPiReleaseCandidateReview,
  parsePyPiReleaseManifest,
} from "../../server/lib/ecosystems/pypi";
import { createAtpmCorpusReview } from "../helpers/atpm-security-corpus.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(__dirname, "..", "fixtures", "security-corpus");

const RISK_RANK = { low: 0, medium: 1, high: 2, critical: 3 };
const SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
// Historical per-file scan window. Detection no longer truncates the scanned
// text (issue #191: the sandbox returns whole files), but pushPastWindow below
// still buries its payload behind this much filler to prove that content past
// the old window is now scanned.
const SAMPLE_LIMIT = 64 * 1024;
const SIGNIFICANT_SEVERITY = SEVERITY_RANK.medium;
// A benign hard negative is a precision miss when the *risk roll-up* surfaces it
// as risky, not merely when a finding fires: these packages legitimately use scary
// capabilities, so a finding emitting is expected. Weighted scoring (issue #193)
// is what keeps the roll-up low; measure FP against the roll-up so the metric
// tracks what the product actually surfaces. Clean regression controls are held
// to the stricter "no significant finding at all" bar below.
const SIGNIFICANT_RISK = RISK_RANK.medium;

const riskRank = (level) => RISK_RANK[level] ?? 0;
const severityRank = (severity) => SEVERITY_RANK[severity] ?? 0;

function readCases(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")));
}

// Derive eval labels. v2 fixtures set verdict/threatClass/expectMinRisk/
// expectAnyRule explicitly; legacy golden fixtures (cases/, cases-pypi/) infer
// them from the existing expectedRisk/expectedFindings fields.
function normalize(fx, kind, ecosystem) {
  const expectedFindings = fx.expectedFindings ?? [];
  const significant = expectedFindings.some(
    (f) => severityRank(f.severity) >= SIGNIFICANT_SEVERITY,
  );
  const derivedVerdict = fx.expectedRisk === "low" && !significant ? "benign" : "malicious";
  const verdict = fx.verdict ?? derivedVerdict;
  return {
    id: fx.id,
    title: fx.title ?? fx.id,
    ecosystem,
    kind,
    verdict,
    threatClass: fx.threatClass ?? fx.category ?? "unclassified",
    source: fx.source ?? "synthetic",
    expectMinRisk: fx.expectMinRisk ?? fx.expectedRisk ?? (verdict === "benign" ? "low" : "high"),
    expectAnyRule: fx.expectAnyRule ?? [...new Set(expectedFindings.map((f) => f.ruleId))],
    fx,
  };
}

export function loadCorpus() {
  const regression = [
    ...readCases(join(CORPUS_DIR, "cases")).map((fx) => normalize(fx, "regression", "npm")),
    ...readCases(join(CORPUS_DIR, "cases-pypi")).map((fx) => normalize(fx, "regression", "pypi")),
    ...readCases(join(CORPUS_DIR, "cases-atpm")).map((fx) => normalize(fx, "regression", "atpm")),
  ];
  const frontier = readCases(join(CORPUS_DIR, "cases-frontier")).map((fx) =>
    normalize(fx, "frontier", fx.ecosystem ?? "npm"),
  );
  const benign = readCases(join(CORPUS_DIR, "cases-benign")).map((fx) =>
    normalize(fx, "benign", fx.ecosystem ?? "npm"),
  );
  return { regression, frontier, benign };
}

function detect(record, fxOverride) {
  const fx = fxOverride ?? record.fx;
  if (record.ecosystem === "atpm") return createAtpmCorpusReview(fx);
  if (record.ecosystem === "pypi") {
    const review = createPyPiReleaseCandidateReview({
      manifest: parsePyPiReleaseManifest(fx.manifest),
      artifacts: fx.artifacts,
      previousArtifacts: fx.previousArtifacts,
    });
    return { risk: review.risk, findings: review.ruleFindings };
  }
  const previousFiles = fx.previousFiles ?? [];
  const stagedFiles = fx.stagedFiles ?? [];
  const diff = createPackageDiff(previousFiles, stagedFiles);
  const packageJsonDiff = summarizePackageJsonDiff(fx.previousPackageJson, fx.stagedPackageJson);
  const findings = [
    ...deterministicFindings(stagedFiles, diff, fx.stagedPackageJson, {
      entrypointResolution: "npm",
    }),
    ...packageJsonDiffFindings(packageJsonDiff),
  ];
  return { risk: computeRisk(findings), findings };
}

function caughtAsMalicious(record, result) {
  const riskOk = riskRank(result.risk) >= riskRank(record.expectMinRisk);
  const ruleOk =
    record.expectAnyRule.length === 0 ||
    result.findings.some((f) => record.expectAnyRule.includes(f.ruleId));
  return riskOk && ruleOk;
}

function hasSignificantFinding(result) {
  return result.findings.some((f) => severityRank(f.severity) >= SIGNIFICANT_SEVERITY);
}

function flaggedAsRisky(result) {
  return riskRank(result.risk) >= SIGNIFICANT_RISK;
}

// --- Evasion transforms (npm/JS). Each mutates file text the way an attacker
// would to slip past regex matching; the payload's *intent* is unchanged. ---

function splitStringLiterals(code) {
  return code.replace(/(['"])((?:\\.|(?!\1).){4,}?)\1/g, (_match, quote, body) => {
    const mid = Math.max(1, Math.floor(body.length / 2));
    return `${quote}${body.slice(0, mid)}${quote}+${quote}${body.slice(mid)}${quote}`;
  });
}

function bracketifyMemberAccess(code) {
  return code
    .replace(/process\.env\b/g, "process['e'+'nv']")
    .replace(/os\.environ\b/g, "os['env'+'iron']");
}

function base64Wrap(code) {
  const encoded = Buffer.from(code, "utf8").toString("base64");
  return `eval(atob(${JSON.stringify(encoded)}));\n`;
}

function pushPastWindow(code) {
  const filler = `// ${"x".repeat(118)}\n`;
  const padding = filler.repeat(Math.ceil((SAMPLE_LIMIT + 4096) / filler.length));
  // Payload sits after >SAMPLE_LIMIT of filler. The transform does NOT truncate:
  // detection now scans the whole file, so the payload past the old window must
  // still be caught (block-slip -> 0%). The bounded display sample is a
  // persistence concern the eval does not exercise.
  return padding + code;
}

const EVASION_TRANSFORMS = {
  splitStringLiterals,
  bracketifyMemberAccess,
  base64Wrap,
  pushPastWindow,
};

function applyTransform(fx, transform) {
  const stagedFiles = (fx.stagedFiles ?? []).map((file) => {
    if (file.path === "package.json" || typeof file.textSample !== "string") return file;
    return { ...file, textSample: transform(file.textSample) };
  });
  return { ...fx, stagedFiles };
}

function hasScannableCodeFile(record) {
  return (record.fx.stagedFiles ?? []).some(
    (file) => file.path !== "package.json" && typeof file.textSample === "string",
  );
}

function codeRuleIds(findings) {
  return new Set(findings.filter((f) => f.ruleId.startsWith("code.")).map((f) => f.ruleId));
}

function recallOf(records) {
  const passed = records.filter((r) => caughtAsMalicious(r, detect(r)));
  return {
    total: records.length,
    passed: passed.length,
    recall: records.length ? passed.length / records.length : 1,
  };
}

export function runEval() {
  const { regression, frontier, benign } = loadCorpus();

  const regMalicious = regression.filter((r) => r.verdict === "malicious");
  const regBenign = regression.filter((r) => r.verdict === "benign");
  const regCritical = regMalicious.filter((r) => r.expectMinRisk === "critical");

  const benignFalsePositives = regBenign.filter((r) => hasSignificantFinding(detect(r)));

  const frontierMisses = frontier.filter((r) => !caughtAsMalicious(r, detect(r)));

  const hardNegativeHits = benign.filter((r) => flaggedAsRisky(detect(r)));

  // Evasion: only mutate npm malicious cases we currently catch and that have a
  // code file to mutate. blockedRate = product still treats it as risky;
  // codeRetention = how many of the original code.* rules still fire.
  const perTransform = {};
  for (const name of Object.keys(EVASION_TRANSFORMS)) {
    perTransform[name] = { samples: 0, blocked: 0, codeRetained: 0, codeTotal: 0 };
  }
  for (const record of regMalicious) {
    if (record.ecosystem !== "npm" || !hasScannableCodeFile(record)) continue;
    const baseline = detect(record);
    if (!caughtAsMalicious(record, baseline)) continue;
    const baseCodeRules = codeRuleIds(baseline.findings);
    for (const [name, transform] of Object.entries(EVASION_TRANSFORMS)) {
      const variant = detect(record, applyTransform(record.fx, transform));
      const variantCodeRules = codeRuleIds(variant.findings);
      const retained = [...baseCodeRules].filter((id) => variantCodeRules.has(id)).length;
      const bucket = perTransform[name];
      bucket.samples += 1;
      if (caughtAsMalicious(record, variant)) bucket.blocked += 1;
      bucket.codeRetained += retained;
      bucket.codeTotal += baseCodeRules.size;
    }
  }
  const evasion = Object.fromEntries(
    Object.entries(perTransform).map(([name, b]) => [
      name,
      {
        samples: b.samples,
        blockedRate: b.samples ? b.blocked / b.samples : null,
        codeRetention: b.codeTotal ? b.codeRetained / b.codeTotal : null,
      },
    ]),
  );

  return {
    generatedAt: new Date().toISOString(),
    rulesVersion: DETERMINISTIC_RULES_VERSION,
    regression: {
      malicious: recallOf(regMalicious),
      critical: recallOf(regCritical),
      benign: { total: regBenign.length, falsePositives: benignFalsePositives.length },
    },
    frontier: {
      total: frontier.length,
      passed: frontier.length - frontierMisses.length,
      recall: frontier.length ? (frontier.length - frontierMisses.length) / frontier.length : 1,
      misses: frontierMisses.map((r) => ({ id: r.id, threatClass: r.threatClass })),
    },
    benignHardNegatives: {
      total: benign.length,
      falsePositives: hardNegativeHits.length,
      fpRate: benign.length ? hardNegativeHits.length / benign.length : 0,
      positives: hardNegativeHits.map((r) => ({ id: r.id, threatClass: r.threatClass })),
    },
    evasion,
  };
}

function pct(value) {
  return value == null ? "n/a" : `${(value * 100).toFixed(0)}%`;
}

function renderMarkdown(result) {
  const lines = [];
  lines.push("# Detection eval report");
  lines.push("");
  lines.push(`- generated: ${result.generatedAt}`);
  lines.push(`- deterministic rules version: ${result.rulesVersion}`);
  lines.push("");
  lines.push("## Regression (gated)");
  lines.push("");
  lines.push("| metric | value |");
  lines.push("| --- | --- |");
  lines.push(
    `| malicious recall | ${pct(result.regression.malicious.recall)} (${result.regression.malicious.passed}/${result.regression.malicious.total}) |`,
  );
  lines.push(
    `| critical recall | ${pct(result.regression.critical.recall)} (${result.regression.critical.passed}/${result.regression.critical.total}) |`,
  );
  lines.push(
    `| benign control false positives | ${result.regression.benign.falsePositives}/${result.regression.benign.total} |`,
  );
  lines.push("");
  lines.push("## Frontier (reported — truth-labeled hard cases)");
  lines.push("");
  lines.push(
    `recall ${pct(result.frontier.recall)} (${result.frontier.passed}/${result.frontier.total})`,
  );
  for (const miss of result.frontier.misses) {
    lines.push(`- MISS \`${miss.id}\` (${miss.threatClass})`);
  }
  lines.push("");
  lines.push("## Benign hard-negatives (reported — false-positive precision)");
  lines.push("");
  lines.push(
    `false positives ${result.benignHardNegatives.falsePositives}/${result.benignHardNegatives.total} (${pct(result.benignHardNegatives.fpRate)})`,
  );
  for (const fp of result.benignHardNegatives.positives) {
    lines.push(`- FALSE POSITIVE \`${fp.id}\` (${fp.threatClass})`);
  }
  lines.push("");
  lines.push("## Evasion robustness (reported)");
  lines.push("");
  lines.push("| transform | samples | still blocked | code rules retained |");
  lines.push("| --- | --- | --- | --- |");
  for (const [name, stats] of Object.entries(result.evasion)) {
    lines.push(
      `| ${name} | ${stats.samples} | ${pct(stats.blockedRate)} | ${pct(stats.codeRetention)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function writeReport(result) {
  try {
    const outDir = join(__dirname, "..", "..", ".context", "eval");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "detection-eval.json"), JSON.stringify(result, null, 2));
    writeFileSync(join(outDir, "detection-eval.md"), renderMarkdown(result));
  } catch {
    // Report writing is best-effort; never fail the eval over a filesystem issue.
  }
}
