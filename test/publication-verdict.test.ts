import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  classifyPublication,
  isSettledUnknownReason,
  type ReviewEvidence,
} from "../server/lib/ecosystems/npm/publication-verdict";

const name = "@drydock/publication-test";
const version = "1.0.0";
const bytes = new TextEncoder().encode("inert artifact bytes; never execute");
const sha1 = createHash("sha1").update(bytes).digest("hex");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const published = new Date("2026-09-12T12:00:00Z");
const otherBytes = { sha1: "c".repeat(40), sha256: "d".repeat(64) };
const before = new Date(published.getTime() - 1000);

function stagedIntegrity(digest: string) {
  return {
    stagedPublish: {
      artifactIntegrity: {
        algorithm: "sha1",
        status: "verified",
        declared: digest,
        computed: digest,
      },
    },
  };
}

function review(overrides: Partial<ReviewEvidence> = {}): ReviewEvidence {
  return {
    id: "scan1",
    source: "auto_discovery",
    registryUrl: "https://registry.npmjs.org",
    registryPackageName: name,
    registryVersion: version,
    registryStatusSupersededAt: null,
    packageName: name,
    stagedVersion: version,
    decision: "publish",
    decidedAt: before,
    status: "complete",
    summaryJson: stagedIntegrity(sha1),
    ...overrides,
  };
}

const classify = (
  reviews: ReviewEvidence[],
  artifact: Parameters<typeof classifyPublication>[3] = { sha1, sha256 },
) => classifyPublication(name, version, published, artifact, reviews);

describe("publication verdicts", () => {
  test("binds staged evidence to digest, registry coordinates and prior decision", () => {
    expect(classify([review()]).status).toBe("approved_match");
    expect(classify([review({ decision: "no_publish" })]).status).toBe(
      "published_despite_rejection",
    );
    expect(classify([review({ decidedAt: published })])).toMatchObject({
      status: "unknown",
      reason: "decision_history_unavailable",
    });
    expect(classify([review({ registryUrl: "https://private.example" })]).status).toBe(
      "published_without_approval",
    );
    expect(classify([review({ registryPackageName: "different" })]).status).toBe(
      "published_without_approval",
    );
    expect(classify([review()], { sha1: "b".repeat(40), sha256 })).toMatchObject({
      status: "artifact_mismatch",
      scanId: "scan1",
    });
    expect(classify([review({ summaryJson: {} })])).toMatchObject({
      status: "unknown",
      reason: "review_digest_unavailable",
    });
    expect(classifyPublication(name, version, null, { sha1, sha256 }, [review()])).toMatchObject({
      status: "unknown",
      reason: "publication_time_unavailable",
    });
  });

  test("verifies workflow manifest identity and actual single artifact digest", () => {
    const gate = review({
      source: "workflow_gate",
      registryUrl: null,
      registryPackageName: null,
      registryVersion: null,
      summaryJson: {
        stagedPublish: {
          mode: "workflow_gate",
          digest: sha256,
          manifest: {
            schema: "drydock.release-artifacts.v1",
            ecosystem: "npm",
            package: name,
            version,
            artifacts: [{ path: "package.tgz", sha256 }],
          },
        },
      },
    });
    expect(classify([gate]).status).toBe("approved_match");
    expect(classifyPublication("other", version, published, { sha1, sha256 }, [gate]).status).toBe(
      "published_without_approval",
    );
  });

  test("a decision overwritten after publication leaves its earlier history unknown", () => {
    const overwritten = review({ decidedAt: new Date(published.getTime() + 1000) });
    expect(classify([overwritten])).toMatchObject({
      status: "unknown",
      reason: "decision_history_unavailable",
    });
    expect(classify([overwritten, review({ id: "scan2" })]).status).toBe("approved_match");
  });

  test("published-pair reviews are never release-path records", () => {
    expect(classify([review({ source: "published" })]).status).toBe("published_without_approval");
  });
});

describe("a release with no Drydock record needs no bytes", () => {
  test.each(["artifact_too_large", "artifact_timeout", "artifact_unavailable", null] as const)(
    "is published without approval even when the artifact is %s",
    (artifact) => {
      expect(classify([], artifact)).toEqual({
        status: "published_without_approval",
        reason: null,
        scanId: null,
      });
    },
  );

  test("an unhashable artifact of a reviewed release stays unknown and says why", () => {
    expect(classify([review()], "artifact_too_large")).toEqual({
      status: "unknown",
      reason: "artifact_too_large",
      scanId: null,
    });
    expect(classify([review()], "artifact_timeout").reason).toBe("artifact_timeout");
  });
});

describe("the owner's own release in flight is never an accusation", () => {
  test.each([
    ["pending", "review_pending"],
    ["running", "review_pending"],
    ["failed", "review_failed"],
  ] as const)("a %s review of the version is unknown (%s)", (status, reason) => {
    const inFlight = review({ status, decision: null, decidedAt: null, summaryJson: null });
    expect(classify([inFlight])).toEqual({ status: "unknown", reason, scanId: "scan1" });
    expect(classify([inFlight], "artifact_too_large").status).toBe("unknown");
  });

  test("a completed undecided review is unknown whether or not its bytes match", () => {
    const undecided = review({ decision: null, decidedAt: null });
    expect(classify([undecided])).toEqual({
      status: "unknown",
      reason: "reviewed_without_decision",
      scanId: "scan1",
    });
    expect(classify([undecided], otherBytes)).toEqual({
      status: "unknown",
      reason: "reviewed_other_artifact",
      scanId: "scan1",
    });
  });

  test("a rejection of other bytes leaves the published release unapproved", () => {
    expect(classify([review({ decision: "no_publish" })], otherBytes).status).toBe(
      "published_without_approval",
    );
  });
});

describe("a restaged version is decided by the review that examined the published bytes", () => {
  const superseded = { registryStatusSupersededAt: new Date(published.getTime() - 500) };
  // Stage A was approved, then the same version was restaged as B and the
  // owner published B.
  const approvedA = review({
    id: "stage-a",
    summaryJson: stagedIntegrity("a".repeat(40)),
    ...superseded,
  });

  test("the current review of the published bytes decides, not the superseded approval", () => {
    expect(
      classify([approvedA, review({ id: "stage-b", decision: null, decidedAt: null })]),
    ).toEqual({ status: "unknown", reason: "reviewed_without_decision", scanId: "stage-b" });
    expect(classify([approvedA, review({ id: "stage-b" })])).toMatchObject({
      status: "approved_match",
      scanId: "stage-b",
    });
    expect(classify([approvedA, review({ id: "stage-b", decision: "no_publish" })])).toMatchObject({
      status: "published_despite_rejection",
      scanId: "stage-b",
    });
  });

  test("a restage still under review is pending, not a mismatch", () => {
    const pendingB = review({
      id: "stage-b",
      status: "pending",
      decision: null,
      decidedAt: null,
      summaryJson: null,
    });
    expect(classify([approvedA, pendingB])).toMatchObject({
      status: "unknown",
      reason: "review_pending",
    });
  });

  test("a superseded approval alone never produces a mismatch", () => {
    expect(classify([approvedA])).toEqual({
      status: "unknown",
      reason: "review_superseded",
      scanId: null,
    });
  });

  test("a superseded approval of the exact published bytes still counts", () => {
    expect(classify([review({ id: "stage-a", ...superseded })])).toMatchObject({
      status: "approved_match",
      scanId: "stage-a",
    });
  });

  test("an approved current stage whose bytes differ is a mismatch", () => {
    expect(
      classify([
        approvedA,
        review({ id: "stage-b", summaryJson: stagedIntegrity("e".repeat(40)) }),
      ]),
    ).toMatchObject({ status: "artifact_mismatch", scanId: "stage-b" });
  });
});

test("settled unknown causes are the ones another check cannot resolve", () => {
  for (const reason of [
    "reviewed_without_decision",
    "reviewed_other_artifact",
    "decision_history_unavailable",
    "review_digest_unavailable",
    "artifact_too_large",
  ]) {
    expect(isSettledUnknownReason(reason), reason).toBe(true);
  }
  for (const reason of ["review_pending", "review_failed", "artifact_timeout", null]) {
    expect(isSettledUnknownReason(reason), String(reason)).toBe(false);
  }
});
