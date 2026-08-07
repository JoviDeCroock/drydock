import { describe, expect, test } from "vitest";
import {
  RELEASE_PROCESS_FINDING_FILE,
  releaseFingerprintFindings,
  SOURCE_DRIFT_MIN_PRIOR_SCANS,
  type CurrentScanFacts,
  type PackageScanHistoryRow,
} from "../server/lib/release-fingerprint";
import { annotateFindingsWithDiffStatus, DETERMINISTIC_RULES_VERSION } from "../server/lib/review";

function currentScan(overrides: Partial<CurrentScanFacts> = {}): CurrentScanFacts {
  return {
    scanId: "scan_current",
    packageName: "pkg-current",
    source: "manual",
    gateRepositoryFullName: null,
    gateEnvironment: null,
    ...overrides,
  };
}

function findingsFor(args: {
  current?: CurrentScanFacts;
  packageHistory?: PackageScanHistoryRow[];
}) {
  return releaseFingerprintFindings({
    current: args.current ?? currentScan(),
    packageHistory: args.packageHistory ?? [],
  });
}

function gateScan(
  id: string,
  repo = "octo/release-repo",
  environment = "release",
): PackageScanHistoryRow {
  return {
    id,
    status: "complete",
    source: "workflow_gate",
    gateRepositoryFullName: repo,
    gateEnvironment: environment,
  };
}

function stagedScan(id: string, source = "manual"): PackageScanHistoryRow {
  return {
    id,
    status: "complete",
    source,
    gateRepositoryFullName: null,
    gateEnvironment: null,
  };
}

describe("release.source-drift", () => {
  const gateHistory = [gateScan("s1"), gateScan("s2"), gateScan("s3")];

  test("fires high when a consistently gated package arrives as a manual scan", () => {
    const findings = findingsFor({
      current: currentScan({ source: "manual" }),
      packageHistory: gateHistory,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "release.source-drift",
      severity: "high",
      file: RELEASE_PROCESS_FINDING_FILE,
      ruleVersion: DETERMINISTIC_RULES_VERSION,
    });
    expect(findings[0].evidence).toContain("octo/release-repo");
    expect(findings[0].evidence).toContain("staged-publish review");
  });

  test("fires high for gated-to-auto-discovery drift too", () => {
    const findings = findingsFor({
      current: currentScan({ source: "auto_discovery" }),
      packageHistory: gateHistory,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("high");
  });

  test("fires medium when the gate repository changes", () => {
    const findings = findingsFor({
      current: currentScan({
        source: "workflow_gate",
        gateRepositoryFullName: "octo/other-repo",
        gateEnvironment: "release",
      }),
      packageHistory: gateHistory,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleId: "release.source-drift", severity: "medium" });
    expect(findings[0].evidence).toContain("octo/other-repo");
  });

  test("fires medium when the gate environment changes", () => {
    const findings = findingsFor({
      current: currentScan({
        source: "workflow_gate",
        gateRepositoryFullName: "octo/release-repo",
        gateEnvironment: "staging",
      }),
      packageHistory: gateHistory,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("medium");
  });

  test("fires medium when a consistently staged package arrives via a workflow gate", () => {
    const findings = findingsFor({
      current: currentScan({
        source: "workflow_gate",
        gateRepositoryFullName: "octo/release-repo",
        gateEnvironment: "release",
      }),
      packageHistory: [stagedScan("s1"), stagedScan("s2"), stagedScan("s3")],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("medium");
  });

  test("manual and auto-discovery are the same staged path (no drift between them)", () => {
    const findings = findingsFor({
      current: currentScan({ source: "manual" }),
      packageHistory: [
        stagedScan("s1", "auto_discovery"),
        stagedScan("s2", "auto_discovery"),
        stagedScan("s3", "auto_discovery"),
      ],
    });
    expect(findings).toEqual([]);
  });

  test("stays silent when the prior history is mixed", () => {
    const findings = findingsFor({
      current: currentScan({ source: "manual" }),
      packageHistory: [gateScan("s1"), gateScan("s2"), stagedScan("s3")],
    });
    expect(findings).toEqual([]);
  });

  test("stays silent below the prior-scan threshold", () => {
    const findings = findingsFor({
      current: currentScan({ source: "manual" }),
      packageHistory: gateHistory.slice(0, SOURCE_DRIFT_MIN_PRIOR_SCANS - 1),
    });
    expect(findings).toEqual([]);
  });

  test("fires at exactly the prior-scan threshold", () => {
    const findings = findingsFor({
      current: currentScan({ source: "manual" }),
      packageHistory: gateHistory.slice(0, SOURCE_DRIFT_MIN_PRIOR_SCANS),
    });
    expect(findings).toHaveLength(1);
  });

  test("ignores non-complete prior scans", () => {
    const findings = findingsFor({
      current: currentScan({ source: "manual" }),
      packageHistory: [gateScan("s1"), gateScan("s2"), { ...gateScan("s3"), status: "failed" }],
    });
    expect(findings).toEqual([]);
  });

  test("stays silent when the matching path is unchanged", () => {
    const findings = findingsFor({
      current: currentScan({
        source: "workflow_gate",
        gateRepositoryFullName: "octo/release-repo",
        gateEnvironment: "release",
      }),
      packageHistory: gateHistory,
    });
    expect(findings).toEqual([]);
  });

  test("stays silent when the current scan's source is unknown", () => {
    const findings = findingsFor({
      current: currentScan({ source: null }),
      packageHistory: gateHistory,
    });
    expect(findings).toEqual([]);
  });

  test("stays silent when the current scan has no package name", () => {
    const findings = findingsFor({
      current: currentScan({ packageName: null }),
      packageHistory: gateHistory,
    });
    expect(findings).toEqual([]);
  });
});

describe("diff annotation of release.* findings", () => {
  test("release-process findings always annotate as release delta despite the synthetic file", () => {
    const findings = findingsFor({
      current: currentScan({ source: "manual" }),
      packageHistory: [gateScan("s1"), gateScan("s2"), gateScan("s3")],
    });
    expect(findings).toHaveLength(1);
    const [annotated] = annotateFindingsWithDiffStatus(findings, [], {});
    expect(annotated).toMatchObject({ diffStatus: "unknown", releaseDelta: true });
  });
});
