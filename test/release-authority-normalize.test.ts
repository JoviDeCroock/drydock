import { describe, expect, it } from "vitest";
import { computeReleaseAuthorityDelta } from "../server/lib/release-authority/delta";
import { normalizeReleaseAuthorityDelta } from "../server/lib/release-authority/normalize-delta";
import { normalizeReleaseAuthoritySnapshot } from "../server/lib/release-authority/normalize";
import { buildReleaseAuthoritySnapshot } from "../server/lib/release-authority/snapshot";
import { parseWorkflowYaml } from "../server/lib/release-authority/yaml";

// Persisted release-authority blobs are read back by tolerant readers, on the
// same contract as normalizeReleaseConsistency: a row from another build, or a
// malformed one, reads as null. Null renders as "not assessed" — which must
// never be confused with "assessed, and nothing changed".

const WORKFLOW = `
on:
  push:
    tags:
      - "v*"
permissions:
  contents: read
jobs:
  publish:
    runs-on: ubuntu-latest
    environment: pypi
    permissions:
      id-token: write
    steps:
      - uses: pypa/gh-action-pypi-publish@release/v1
`;

async function snapshot(workflow = WORKFLOW) {
  const parsed = parseWorkflowYaml(workflow);
  return buildReleaseAuthoritySnapshot({
    run: {
      repositoryFullName: "octo/example",
      environment: "pypi",
      runId: 7,
      runAttempt: 1,
      workflowPath: ".github/workflows/release.yml",
      headSha: "a".repeat(40),
      ref: "refs/tags/v1.0.0",
      event: "push",
      actor: "octo",
      triggeringActor: "octo",
    },
    workflows: [
      {
        path: ".github/workflows/release.yml",
        repositoryFullName: "octo/example",
        sha: "a".repeat(40),
        ref: "refs/tags/v1.0.0",
        role: "entry",
        content: workflow,
        document: parsed.value,
        documentComplete: parsed.complete,
      },
    ],
    artifacts: [{ name: "pkg-1.0.0.tar.gz", kind: "sdist", sha256: "ab".repeat(32) }],
    unresolved: [],
  });
}

describe("normalizeReleaseAuthoritySnapshot", () => {
  it("round-trips a persisted snapshot through JSON", async () => {
    const original = await snapshot();
    const restored = normalizeReleaseAuthoritySnapshot(JSON.parse(JSON.stringify(original)));
    expect(restored).toEqual(original);
  });

  it("rejects a blob written under a different schema", async () => {
    const original = await snapshot();
    expect(
      normalizeReleaseAuthoritySnapshot({ ...original, schema: "drydock.release-authority.v0" }),
    ).toBeNull();
  });

  it("rejects blobs it cannot make sense of", () => {
    expect(normalizeReleaseAuthoritySnapshot(null)).toBeNull();
    expect(normalizeReleaseAuthoritySnapshot("{}")).toBeNull();
    expect(normalizeReleaseAuthoritySnapshot([])).toBeNull();
    expect(
      normalizeReleaseAuthoritySnapshot({ schema: "drydock.release-authority.v1" }),
    ).toBeNull();
  });

  it("drops malformed list entries instead of failing the whole snapshot", async () => {
    const original = await snapshot();
    const restored = normalizeReleaseAuthoritySnapshot({
      ...JSON.parse(JSON.stringify(original)),
      permissions: [
        { workflow: "w", job: null, scope: "contents", level: "read" },
        { workflow: "w", scope: "id-token", level: "not-a-level" },
        "garbage",
        null,
      ],
    });
    expect(restored?.permissions).toEqual([
      { workflow: "w", job: null, scope: "contents", level: "read" },
      // An unreadable level normalizes to `unknown`, which ranks at the top so
      // it can never read as a narrowing.
      { workflow: "w", job: null, scope: "id-token", level: "unknown" },
    ]);
    expect(restored?.coverage.complete).toBe(false);
  });

  it("treats a missing persisted trigger filter as incomplete evidence", async () => {
    const original = await snapshot();
    const persisted = JSON.parse(JSON.stringify(original));
    delete persisted.triggers[0].filter;

    const restored = normalizeReleaseAuthoritySnapshot(persisted);
    expect(restored?.triggers).toEqual([]);
    expect(restored?.coverage.complete).toBe(false);
  });

  it("treats missing persisted job identities as incomplete evidence", async () => {
    const original = await snapshot();
    const persisted = JSON.parse(JSON.stringify(original));
    delete persisted.workflows[0].jobs;

    const restored = normalizeReleaseAuthoritySnapshot(persisted);

    expect(restored?.workflows[0]?.jobs).toBeNull();
    expect(restored?.coverage.complete).toBe(false);
  });

  it("treats coverage as incomplete when unresolved entries survive", async () => {
    const original = await snapshot();
    const restored = normalizeReleaseAuthoritySnapshot({
      ...JSON.parse(JSON.stringify(original)),
      coverage: { complete: true, unresolved: [{ path: "x.yml", reason: "not_accessible" }] },
    });
    // A blob that claims completeness while carrying unresolved entries is not
    // trusted: the conservative reading wins.
    expect(restored?.coverage.complete).toBe(false);
  });

  it("treats coverage as incomplete when malformed unresolved entries are dropped", async () => {
    const original = await snapshot();
    const restored = normalizeReleaseAuthoritySnapshot({
      ...JSON.parse(JSON.stringify(original)),
      coverage: { complete: true, unresolved: ["garbage"] },
    });
    expect(restored?.coverage).toEqual({ complete: false, unresolved: [] });
  });

  it("rejects malformed artifact digests while preserving intentional missing evidence", async () => {
    const original = await snapshot();
    const restored = normalizeReleaseAuthoritySnapshot({
      ...JSON.parse(JSON.stringify(original)),
      artifacts: [
        { name: "valid.whl", kind: "wheel", sha256: "AB".repeat(32) },
        { name: "missing.tar.gz", kind: "sdist", sha256: "" },
        { name: "invalid.tar.gz", kind: "sdist", sha256: "not-a-sha256" },
      ],
    });

    expect(restored?.artifacts).toEqual([
      { name: "valid.whl", kind: "wheel", sha256: "ab".repeat(32) },
      { name: "missing.tar.gz", kind: "sdist", sha256: "" },
    ]);
    expect(restored?.coverage.complete).toBe(false);
    expect(computeReleaseAuthorityDelta(restored!, null).standing.artifactsWithoutDigest).toBe(1);
  });

  it("treats a snapshot without exactly one entry workflow as incomplete", async () => {
    const original = await snapshot();
    const persisted = JSON.parse(JSON.stringify(original));
    persisted.workflows = [];
    persisted.coverage = { complete: true, unresolved: [] };

    const restored = normalizeReleaseAuthoritySnapshot(persisted);
    expect(restored?.workflows).toEqual([]);
    expect(restored?.coverage.complete).toBe(false);
    expect(computeReleaseAuthorityDelta(restored!, null)).toMatchObject({
      status: "changed",
      requiresApproval: true,
      changes: [expect.objectContaining({ kind: "coverage_incomplete" })],
    });
  });

  it("fails closed when persisted workflow authority digests are missing", async () => {
    const current = await snapshot();
    const persisted = JSON.parse(JSON.stringify(current));
    persisted.workflows[0].authorityDigest = null;

    const restored = normalizeReleaseAuthoritySnapshot(persisted);
    expect(restored?.workflows).toEqual([]);
    expect(restored?.coverage.complete).toBe(false);

    const delta = computeReleaseAuthorityDelta(current, {
      snapshot: restored!,
      ref: {
        snapshotId: "snap-1",
        gateId: "gate-1",
        runId: 1,
        headSha: "a".repeat(40),
        approvedAt: "2026-07-01T00:00:00.000Z",
      },
    });
    expect(delta.status).toBe("changed");
    expect(delta.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "workflow_added" })]),
    );
  });
});

describe("normalizeReleaseAuthorityDelta", () => {
  it("round-trips a persisted delta through JSON", async () => {
    const prior = await snapshot();
    const current = await snapshot(WORKFLOW.replace("  contents: read", "  contents: write"));
    const delta = computeReleaseAuthorityDelta(current, {
      snapshot: prior,
      ref: {
        snapshotId: "snap-1",
        gateId: "gate-1",
        runId: 1,
        headSha: "a".repeat(40),
        approvedAt: "2026-07-01T00:00:00.000Z",
      },
    });
    expect(delta.status).toBe("changed");
    expect(normalizeReleaseAuthorityDelta(JSON.parse(JSON.stringify(delta)))).toEqual(delta);
  });

  it("recomputes requiresApproval from the stored status rather than trusting it", () => {
    const restored = normalizeReleaseAuthorityDelta({
      schema: "drydock.release-authority-delta.v1",
      status: "changed",
      baseline: null,
      changes: [
        {
          kind: "coverage_incomplete",
          significance: "medium",
          scope: "coverage",
          subject: "authority graph",
          before: "no baseline",
          after: "unreadable",
        },
      ],
      changeCount: 1,
      highestSignificance: "none",
      standing: {
        mutableRefs: [],
        coverageComplete: true,
        unresolved: [],
        artifactsWithoutDigest: 0,
      },
      // A row claiming no approval is needed for a changed authority must not
      // be able to unblock a release by saying so.
      requiresApproval: false,
    });
    expect(restored?.requiresApproval).toBe(true);
    expect(restored?.highestSignificance).toBe("medium");
  });

  it("rejects unknown change kinds rather than presenting partial evidence", () => {
    const restored = normalizeReleaseAuthorityDelta({
      schema: "drydock.release-authority-delta.v1",
      status: "changed",
      baseline: null,
      changes: [
        { kind: "permission_widened", significance: "high", scope: "w/j", subject: "contents" },
        { kind: "kind_from_the_future", significance: "high", scope: "w/j", subject: "x" },
      ],
      changeCount: 2,
      highestSignificance: "high",
      standing: {
        mutableRefs: [],
        coverageComplete: true,
        unresolved: [],
        artifactsWithoutDigest: 0,
      },
      requiresApproval: true,
    });
    expect(restored).toBeNull();
  });

  it("rejects incomplete same-schema deltas instead of reporting unchanged", () => {
    expect(
      normalizeReleaseAuthorityDelta({
        schema: "drydock.release-authority-delta.v1",
        status: "unchanged",
      }),
    ).toBeNull();
  });

  it("rejects malformed standing evidence instead of dropping it", () => {
    expect(
      normalizeReleaseAuthorityDelta({
        schema: "drydock.release-authority-delta.v1",
        status: "unchanged",
        baseline: {
          snapshotId: "snap-1",
          gateId: "gate-1",
          runId: 1,
          headSha: "a".repeat(40),
          approvedAt: "2026-07-01T00:00:00.000Z",
        },
        changes: [],
        changeCount: 0,
        highestSignificance: "none",
        standing: {
          mutableRefs: [],
          coverageComplete: true,
          unresolved: ["garbage"],
          artifactsWithoutDigest: 0,
        },
        requiresApproval: false,
      }),
    ).toBeNull();
  });

  it.each(["no_baseline", "unchanged", "cosmetic"] as const)(
    "rejects %s when persisted standing coverage is incomplete",
    (status) => {
      const baseline =
        status === "no_baseline"
          ? null
          : {
              snapshotId: "snap-1",
              gateId: "gate-1",
              runId: 1,
              headSha: "a".repeat(40),
              approvedAt: "2026-07-01T00:00:00.000Z",
            };
      const changes =
        status === "cosmetic"
          ? [
              {
                kind: "workflow_content_changed",
                significance: "low",
                scope: ".github/workflows/release.yml",
                subject: "workflow content",
              },
            ]
          : [];

      expect(
        normalizeReleaseAuthorityDelta({
          schema: "drydock.release-authority-delta.v1",
          status,
          baseline,
          changes,
          changeCount: changes.length,
          highestSignificance: status === "cosmetic" ? "low" : "none",
          standing: {
            mutableRefs: [],
            coverageComplete: false,
            unresolved: [{ path: "x.yml", reason: "not_accessible" }],
            artifactsWithoutDigest: 0,
          },
          requiresApproval: false,
        }),
      ).toBeNull();
    },
  );

  it("rejects blobs it cannot make sense of", () => {
    expect(normalizeReleaseAuthorityDelta(null)).toBeNull();
    expect(normalizeReleaseAuthorityDelta({ schema: "other", status: "changed" })).toBeNull();
    expect(
      normalizeReleaseAuthorityDelta({
        schema: "drydock.release-authority-delta.v1",
        status: "invented",
      }),
    ).toBeNull();
  });
});
