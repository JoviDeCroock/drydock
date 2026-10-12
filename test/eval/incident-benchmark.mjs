import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DETERMINISTIC_RULES_VERSION } from "../../server/lib/review";
import { evaluateNpmFixture } from "./harness.mjs";

const fixtureRoot = new URL("../fixtures/incident-benchmark/v1/", import.meta.url);
const riskRank = { low: 0, medium: 1, high: 2, critical: 3 };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const incidentBenchmarkReportPath = fileURLToPath(
  new URL("../../public/benchmarks/shai-hulud-nx/v1.json", import.meta.url),
);

export function classifyIncidentCase(fixture) {
  const { artifactRisk, releaseRisk, findings } = evaluateNpmFixture(fixture);
  const requiredRulesPresent = fixture.requiredRuleIds.every((ruleId) =>
    findings.some((finding) => finding.ruleId === ruleId && finding.releaseDelta),
  );
  return {
    artifactRisk,
    releaseRisk,
    caught:
      fixture.verdict === "malicious"
        ? riskRank[releaseRisk] >= riskRank[fixture.expectedMinRisk] && requiredRulesPresent
        : null,
    falsePositive: fixture.verdict === "benign" ? riskRank[releaseRisk] >= riskRank.medium : null,
    findings: findings
      .map((finding) => ({
        ruleId: finding.ruleId ?? "unknown",
        severity: finding.severity,
        filePath: finding.file || null,
        releaseDelta: finding.releaseDelta,
        message: finding.reason,
      }))
      .sort((a, b) =>
        `${a.ruleId}\0${a.filePath}\0${a.severity}`.localeCompare(
          `${b.ruleId}\0${b.filePath}\0${b.severity}`,
        ),
      ),
  };
}

export function runIncidentBenchmark() {
  const manifestBytes = readFileSync(new URL("manifest.json", fixtureRoot));
  const { fixtures, ...metadata } = JSON.parse(manifestBytes.toString("utf8"));
  const inputs = [{ path: "manifest.json", sha256: sha256(manifestBytes) }];
  const cases = fixtures.map((name) => {
    const bytes = readFileSync(new URL(name, fixtureRoot));
    const fixture = JSON.parse(bytes.toString("utf8"));
    const fixtureSha256 = sha256(bytes);
    inputs.push({ path: name, sha256: fixtureSha256 });
    return {
      id: fixture.id,
      title: fixture.title,
      incident: fixture.incident,
      verdict: fixture.verdict,
      fixturePath: `test/fixtures/incident-benchmark/v1/${name}`,
      fixtureSha256,
      provenance: fixture.provenance,
      expectedMinRisk: fixture.expectedMinRisk,
      requiredRuleIds: fixture.requiredRuleIds,
      ...classifyIncidentCase(fixture),
    };
  });
  const malicious = cases.filter((entry) => entry.verdict === "malicious");
  const benign = cases.filter((entry) => entry.verdict === "benign");
  return {
    ...metadata,
    rulesVersion: DETERMINISTIC_RULES_VERSION,
    corpusSha256: sha256(JSON.stringify(inputs)),
    summary: {
      malicious: {
        total: malicious.length,
        caught: malicious.filter((entry) => entry.caught).length,
        missed: malicious.filter((entry) => !entry.caught).length,
      },
      benign: {
        total: benign.length,
        falsePositives: benign.filter((entry) => entry.falsePositive).length,
      },
    },
    cases,
  };
}
