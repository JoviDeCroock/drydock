import { describe, expect, test } from "vitest";
import {
  BURST_DISTINCT_PACKAGE_THRESHOLD,
  BURST_EVIDENCE_PACKAGE_LIMIT,
  BURST_MIN_ORG_HISTORY_DAYS,
  BURST_MIN_PRIOR_COMPLETED_SCANS,
  BURST_WINDOW_MS,
  RELEASE_PROCESS_FINDING_FILE,
  releaseFingerprintFindings,
  SOURCE_DRIFT_MIN_PRIOR_SCANS,
  type CurrentScanFacts,
  type OrgScanHistoryRow,
  type PackageScanHistoryRow,
} from "../server/lib/release-fingerprint";
import { annotateFindingsWithDiffStatus, DETERMINISTIC_RULES_VERSION } from "../server/lib/review";

const NOW = new Date("2026-07-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60 * 1000);
}

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

let seq = 0;
function orgRow(overrides: Partial<OrgScanHistoryRow> = {}): OrgScanHistoryRow {
  seq += 1;
  return {
    id: `scan_${seq}`,
    packageName: `pkg-${seq}`,
    status: "complete",
    createdAt: daysAgo(40),
    ...overrides,
  };
}

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

/**
 * Baseline org history that satisfies burst preconditions: old enough
 * (>= BURST_MIN_ORG_HISTORY_DAYS), enough prior completions, no prior burst
 * (one scan per day, one package per scan).
 */
function quietOrgHistory(): OrgScanHistoryRow[] {
  return Array.from({ length: BURST_MIN_PRIOR_COMPLETED_SCANS + 1 }, (_, index) =>
    orgRow({ createdAt: daysAgo(BURST_MIN_ORG_HISTORY_DAYS + 10 + index) }),
  );
}

/** N distinct packages scanned inside the current 30-minute window. */
function windowRows(count: number): OrgScanHistoryRow[] {
  return Array.from({ length: count }, (_, index) =>
    orgRow({
      packageName: `burst-pkg-${index}`,
      status: "running",
      createdAt: minutesAgo(index + 1),
    }),
  );
}

function findingsFor(args: {
  current?: CurrentScanFacts;
  orgHistory?: OrgScanHistoryRow[];
  orgHistoryTruncated?: boolean;
  packageHistory?: PackageScanHistoryRow[];
}) {
  return releaseFingerprintFindings({
    now: NOW,
    current: args.current ?? currentScan(),
    orgHistory: args.orgHistory ?? [],
    orgHistoryTruncated: args.orgHistoryTruncated,
    packageHistory: args.packageHistory ?? [],
  });
}

describe("release.burst-anomaly", () => {
  test("fires when the current scan completes an unprecedented multi-package window", () => {
    // 4 window rows + the current scan itself = exactly the threshold.
    const findings = findingsFor({
      orgHistory: [...quietOrgHistory(), ...windowRows(BURST_DISTINCT_PACKAGE_THRESHOLD - 1)],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "release.burst-anomaly",
      severity: "high",
      file: RELEASE_PROCESS_FINDING_FILE,
      ruleVersion: DETERMINISTIC_RULES_VERSION,
    });
    expect(findings[0].evidence).toContain(`${BURST_DISTINCT_PACKAGE_THRESHOLD} distinct packages`);
    expect(findings[0].evidence).toContain("pkg-current");
    expect(findings[0].evidence).toContain("burst-pkg-0");
  });

  test("stays silent one below the distinct-package threshold", () => {
    const findings = findingsFor({
      orgHistory: [...quietOrgHistory(), ...windowRows(BURST_DISTINCT_PACKAGE_THRESHOLD - 2)],
    });
    expect(findings).toEqual([]);
  });

  test("counts distinct packages, not scans, inside the window", () => {
    const duplicates = Array.from({ length: 10 }, (_, index) =>
      orgRow({ packageName: "same-pkg", status: "running", createdAt: minutesAgo(index + 1) }),
    );
    expect(findingsFor({ orgHistory: [...quietOrgHistory(), ...duplicates] })).toEqual([]);
  });

  test("scans outside the 30-minute window do not count toward the burst", () => {
    const stale = Array.from({ length: BURST_DISTINCT_PACKAGE_THRESHOLD }, (_, index) =>
      orgRow({
        packageName: `stale-pkg-${index}`,
        createdAt: new Date(NOW.getTime() - BURST_WINDOW_MS - (index + 1) * 60 * 1000),
      }),
    );
    // Stale rows are 31+ minutes old (they instead count as a prior-window
    // burst, which suppresses); only 3 rows + current sit inside the window.
    const findings = findingsFor({
      orgHistory: [...quietOrgHistory(), ...stale, ...windowRows(3)],
    });
    expect(findings).toEqual([]);
  });

  test("suppresses when the org has less than the minimum history age", () => {
    const youngHistory = Array.from({ length: 10 }, (_, index) =>
      orgRow({ createdAt: daysAgo(BURST_MIN_ORG_HISTORY_DAYS - 5 - index * 0.5) }),
    );
    const findings = findingsFor({
      orgHistory: [...youngHistory, ...windowRows(BURST_DISTINCT_PACKAGE_THRESHOLD)],
    });
    expect(findings).toEqual([]);
  });

  test("suppresses when the org has too few prior completed scans", () => {
    const sparse = Array.from({ length: BURST_MIN_PRIOR_COMPLETED_SCANS - 1 }, (_, index) =>
      orgRow({ createdAt: daysAgo(BURST_MIN_ORG_HISTORY_DAYS + 10 + index) }),
    );
    const findings = findingsFor({
      orgHistory: [...sparse, ...windowRows(BURST_DISTINCT_PACKAGE_THRESHOLD)],
    });
    expect(findings).toEqual([]);
  });

  test("failed scans age the history but do not count as completions", () => {
    const failed = Array.from({ length: BURST_MIN_PRIOR_COMPLETED_SCANS + 3 }, (_, index) =>
      orgRow({ status: "failed", createdAt: daysAgo(BURST_MIN_ORG_HISTORY_DAYS + 10 + index) }),
    );
    const findings = findingsFor({
      orgHistory: [...failed, ...windowRows(BURST_DISTINCT_PACKAGE_THRESHOLD)],
    });
    expect(findings).toEqual([]);
  });

  test("suppresses when a prior window already reached the threshold (monorepo release train)", () => {
    const train = Array.from({ length: BURST_DISTINCT_PACKAGE_THRESHOLD }, (_, index) =>
      orgRow({
        packageName: `train-pkg-${index}`,
        createdAt: new Date(daysAgo(20).getTime() + index * 60 * 1000),
      }),
    );
    const findings = findingsFor({
      orgHistory: [...quietOrgHistory(), ...train, ...windowRows(BURST_DISTINCT_PACKAGE_THRESHOLD)],
    });
    expect(findings).toEqual([]);
  });

  test("a spread-out prior release train (never 5 distinct inside 30 minutes) does not suppress", () => {
    const spread = Array.from({ length: BURST_DISTINCT_PACKAGE_THRESHOLD }, (_, index) =>
      orgRow({
        packageName: `spread-pkg-${index}`,
        createdAt: new Date(daysAgo(20).getTime() + index * (BURST_WINDOW_MS + 60 * 1000)),
      }),
    );
    const findings = findingsFor({
      orgHistory: [
        ...quietOrgHistory(),
        ...spread,
        ...windowRows(BURST_DISTINCT_PACKAGE_THRESHOLD),
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe("release.burst-anomaly");
  });

  test("suppresses when the history fetch was truncated", () => {
    const findings = findingsFor({
      orgHistory: [...quietOrgHistory(), ...windowRows(BURST_DISTINCT_PACKAGE_THRESHOLD)],
      orgHistoryTruncated: true,
    });
    expect(findings).toEqual([]);
  });

  test("ignores a stray history row for the current scan itself", () => {
    const selfRow = orgRow({
      id: "scan_current",
      packageName: "self-echo",
      status: "running",
      createdAt: minutesAgo(1),
    });
    const findings = findingsFor({
      orgHistory: [...quietOrgHistory(), ...windowRows(3), selfRow],
    });
    // 3 window rows + current = 4 distinct; the echo row must not add a fifth.
    expect(findings).toEqual([]);
  });

  test("caps evidence at the package-name limit and reports the overflow", () => {
    const findings = findingsFor({
      orgHistory: [...quietOrgHistory(), ...windowRows(BURST_EVIDENCE_PACKAGE_LIMIT + 3)],
    });
    expect(findings).toHaveLength(1);
    const listed = findings[0].evidence.split(": ")[1];
    expect(listed.split(", ")).toHaveLength(BURST_EVIDENCE_PACKAGE_LIMIT);
    expect(findings[0].evidence).toContain("(+4 more)");
  });
});

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
