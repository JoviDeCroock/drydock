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
      changes: [],
      changeCount: 0,
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
  });

  it("drops unknown change kinds rather than rendering them", () => {
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
    expect(restored?.changes.map((change) => change.kind)).toEqual(["permission_widened"]);
    // The original count is preserved so the UI does not silently under-report.
    expect(restored?.changeCount).toBe(2);
  });

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
