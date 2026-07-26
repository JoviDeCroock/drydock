import { describe, expect, test } from "vitest";
import {
  RELEASE_CONSISTENCY_NEW_FINDINGS_CAP,
  buildFindingProfile,
  compareFindingProfiles,
  computeReleaseConsistency,
  noneReleaseConsistency,
  normalizeReleaseConsistency,
} from "../server/lib/scan/release-memory";

const spawn = (file: string, severity = "high") => ({
  ruleId: "code.child-process",
  severity,
  file,
  evidence: "spawn('node')",
  reason: "spawns a process",
  line: 3,
});

describe("buildFindingProfile", () => {
  test("keeps only (ruleId, severity, file), sorted stably", () => {
    const profile = buildFindingProfile([
      { ruleId: "code.network", severity: "medium", file: "lib/b.js" },
      spawn("lib/a.js"),
      { ruleId: "code.network", severity: "medium", file: "lib/a.js" },
    ]);

    expect(profile).toEqual([
      { ruleId: "code.child-process", severity: "high", file: "lib/a.js" },
      { ruleId: "code.network", severity: "medium", file: "lib/a.js" },
      { ruleId: "code.network", severity: "medium", file: "lib/b.js" },
    ]);
    // line/evidence never survive into the profile.
    expect(profile[0]).not.toHaveProperty("line");
    expect(profile[0]).not.toHaveProperty("evidence");
  });

  test("findings without a ruleId participate as 'unknown'", () => {
    const profile = buildFindingProfile([
      { severity: "low", file: "x.js" },
      { ruleId: null, severity: "low", file: "y.js" },
    ]);
    expect(profile.map((entry) => entry.ruleId)).toEqual(["unknown", "unknown"]);
  });
});

describe("compareFindingProfiles", () => {
  test("identical multisets match regardless of input order", () => {
    const current = buildFindingProfile([spawn("a.js"), spawn("b.js")]);
    const prior = buildFindingProfile([spawn("b.js"), spawn("a.js")]);
    expect(compareFindingProfiles(current, prior)).toEqual({
      status: "match",
      newFindings: [],
      newFindingCount: 0,
    });
  });

  test("duplicate rule hits are compared as a multiset, not a set", () => {
    // Two identical (ruleId, severity, file) hits now vs one before is NOT a
    // subset — the extra occurrence is a new finding.
    const current = buildFindingProfile([spawn("a.js"), spawn("a.js")]);
    const prior = buildFindingProfile([spawn("a.js")]);
    const out = compareFindingProfiles(current, prior);
    expect(out.status).toBe("diverged");
    expect(out.newFindingCount).toBe(1);
    expect(out.newFindings).toEqual([
      { ruleId: "code.child-process", severity: "high", file: "a.js" },
    ]);
  });

  test("strict multiset subset (including duplicates) reports subset", () => {
    const current = buildFindingProfile([spawn("a.js")]);
    const prior = buildFindingProfile([spawn("a.js"), spawn("a.js"), spawn("b.js")]);
    expect(compareFindingProfiles(current, prior).status).toBe("subset");
  });

  test("severity changes on the same rule/file diverge", () => {
    const current = buildFindingProfile([spawn("a.js", "critical")]);
    const prior = buildFindingProfile([spawn("a.js", "high")]);
    const out = compareFindingProfiles(current, prior);
    expect(out.status).toBe("diverged");
    expect(out.newFindings).toEqual([
      { ruleId: "code.child-process", severity: "critical", file: "a.js" },
    ]);
  });

  test("empty vs empty matches; empty vs non-empty is a subset", () => {
    expect(compareFindingProfiles([], []).status).toBe("match");
    expect(compareFindingProfiles([], buildFindingProfile([spawn("a.js")])).status).toBe("subset");
  });

  test("caps reported new findings while keeping the true count", () => {
    const current = buildFindingProfile(
      Array.from({ length: 30 }, (_, i) => spawn(`file-${String(i).padStart(2, "0")}.js`)),
    );
    const out = compareFindingProfiles(current, []);
    expect(out.status).toBe("diverged");
    expect(out.newFindingCount).toBe(30);
    expect(out.newFindings).toHaveLength(RELEASE_CONSISTENCY_NEW_FINDINGS_CAP);
  });
});

describe("computeReleaseConsistency", () => {
  test("returns none when there is no prior approved scan", () => {
    expect(computeReleaseConsistency([spawn("a.js")], null)).toEqual({
      status: "none",
      priorScanId: null,
      priorVersion: null,
      decidedAt: null,
      currentFindingCount: 1,
      priorFindingCount: 0,
      newFindingCount: 0,
      newFindings: [],
    });
  });

  test("carries the prior scan identity and counts on a match", () => {
    const decidedAt = new Date("2026-07-01T12:00:00.000Z");
    const out = computeReleaseConsistency([spawn("a.js")], {
      scanId: "scan-prior",
      stagedVersion: "5.7.4",
      decidedAt,
      findings: [spawn("a.js")],
    });
    expect(out).toEqual({
      status: "match",
      priorScanId: "scan-prior",
      priorVersion: "5.7.4",
      decidedAt: "2026-07-01T12:00:00.000Z",
      currentFindingCount: 1,
      priorFindingCount: 1,
      newFindingCount: 0,
      newFindings: [],
    });
  });
});

describe("normalizeReleaseConsistency", () => {
  test("round-trips a computed value", () => {
    const value = computeReleaseConsistency([spawn("a.js"), { severity: "low", file: "b.js" }], {
      scanId: "scan-prior",
      stagedVersion: "1.0.0",
      decidedAt: "2026-07-01T12:00:00.000Z",
      findings: [],
    });
    expect(normalizeReleaseConsistency(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });

  test("tolerates absence and garbage from old scans", () => {
    expect(normalizeReleaseConsistency(undefined)).toBeNull();
    expect(normalizeReleaseConsistency(null)).toBeNull();
    expect(normalizeReleaseConsistency("match")).toBeNull();
    expect(normalizeReleaseConsistency([])).toBeNull();
    expect(normalizeReleaseConsistency({})).toBeNull();
    expect(normalizeReleaseConsistency({ status: "sideways" })).toBeNull();
  });

  test("defaults malformed fields instead of rejecting the whole value", () => {
    expect(
      normalizeReleaseConsistency({
        status: "diverged",
        priorScanId: 42,
        decidedAt: {},
        currentFindingCount: -3,
        newFindingCount: 2.9,
        newFindings: [{ ruleId: "r", severity: "high", file: "a.js" }, { ruleId: "broken" }, "x"],
      }),
    ).toEqual({
      status: "diverged",
      priorScanId: null,
      priorVersion: null,
      decidedAt: null,
      currentFindingCount: 0,
      priorFindingCount: 0,
      newFindingCount: 2,
      newFindings: [{ ruleId: "r", severity: "high", file: "a.js" }],
    });
  });

  test("noneReleaseConsistency normalizes to itself", () => {
    const none = noneReleaseConsistency(2);
    expect(normalizeReleaseConsistency(none)).toEqual(none);
  });
});
