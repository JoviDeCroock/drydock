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
    stagedDeclaredSha1: null,
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
    // An approval whose record carries no digest cannot vouch for any bytes.
    expect(classify([review({ summaryJson: {} })])).toMatchObject({
      status: "artifact_mismatch",
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
    // An earlier visible decision on the same bytes does not settle it: the
    // overwritten one may have been newer, in either direction.
    expect(classify([overwritten, review({ id: "scan2" })])).toMatchObject({
      status: "unknown",
      reason: "decision_history_unavailable",
    });
    expect(classify([overwritten, review({ id: "scan2", decision: "no_publish" })]).status).toBe(
      "unknown",
    );
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
});

const stageSha1 = "5".repeat(40);
const inFlight = (
  status: "pending" | "running" | "failed",
  overrides: Partial<ReviewEvidence> = {},
) =>
  review({
    status,
    decision: null,
    decidedAt: null,
    summaryJson: null,
    stagedDeclaredSha1: sha1,
    ...overrides,
  });

describe("a record of the same bytes softens nothing without a decision", () => {
  // An attacker who can stage creates the record (npm's stage shasum) for the
  // very bytes they then publish directly, and npm reports a promoted stage and
  // a direct publish the same way, so the review points at what to decide.
  test.each([
    ["pending", "review_pending"],
    ["running", "review_pending"],
    ["failed", "review_failed"],
  ] as const)(
    "a %s review of the published bytes, known by npm's stage shasum, is published without approval (%s)",
    (status, reason) => {
      expect(classify([inFlight(status)])).toEqual({
        status: "published_without_approval",
        reason,
        scanId: "scan1",
      });
    },
  );

  test("a completed review of the published bytes with no decision is published without approval", () => {
    expect(classify([review({ decision: null, decidedAt: null })])).toEqual({
      status: "published_without_approval",
      reason: "reviewed_without_decision",
      scanId: "scan1",
    });
  });

  test("rejecting the published bytes after publication raises the rejection alert", () => {
    const after = new Date(published.getTime() + 60_000);
    expect(classify([review({ decision: "no_publish", decidedAt: after })])).toEqual({
      status: "published_despite_rejection",
      reason: "rejected_after_publication",
      scanId: "scan1",
    });
    // The stage the attacker created, rejected once someone noticed.
    expect(
      classify([inFlight("failed", { decision: "no_publish", decidedAt: after })]),
    ).toMatchObject({
      status: "published_despite_rejection",
      reason: "rejected_after_publication",
    });
    // A rejection before publication still reads as one, whatever came later.
    expect(
      classify([
        review({ id: "early", decision: "no_publish" }),
        review({ id: "late", decision: "no_publish", decidedAt: after }),
      ]),
    ).toEqual({ status: "published_despite_rejection", reason: null, scanId: "early" });
  });

  test("a record with no digest at all cannot vouch", () => {
    expect(classify([inFlight("pending", { stagedDeclaredSha1: null })]).status).toBe(
      "published_without_approval",
    );
  });

  test("npm's stage shasum identifies the owner's bytes but never stands in for an approval", () => {
    const unverified = review({
      summaryJson: { stagedPublish: { shasum: sha1 } },
    });
    expect(classify([unverified])).toMatchObject({
      status: "unknown",
      reason: "review_digest_unavailable",
    });
    expect(classify([{ ...unverified, decision: "no_publish" }]).status).toBe(
      "published_despite_rejection",
    );
  });

  test("a benign seed stage cannot soften a different published artifact", () => {
    // Attacker stages benign bytes, lets Drydock review them, then publishes
    // different bytes as the same version.
    expect(classify([review({ decision: null, decidedAt: null })], otherBytes)).toEqual({
      status: "published_without_approval",
      reason: null,
      scanId: null,
    });
    expect(
      classify([inFlight("pending", { stagedDeclaredSha1: stageSha1 })], otherBytes).status,
    ).toBe("published_without_approval");
    expect(
      classify([inFlight("failed", { stagedDeclaredSha1: stageSha1 })], otherBytes).status,
    ).toBe("published_without_approval");
  });

  test("a rejection of other bytes is a mismatch, whenever it was decided", () => {
    expect(classify([review({ decision: "no_publish" })], otherBytes)).toMatchObject({
      status: "artifact_mismatch",
      scanId: "scan1",
    });
  });
});

describe("a restaged version", () => {
  const superseded = { registryStatusSupersededAt: new Date(published.getTime() - 500) };
  const approvedA = review({
    id: "stage-a",
    summaryJson: stagedIntegrity("a".repeat(40)),
    ...superseded,
  });

  test("the owner's restage of the published bytes decides", () => {
    expect(
      classify([approvedA, review({ id: "stage-b", decision: null, decidedAt: null })]),
    ).toEqual({
      status: "published_without_approval",
      reason: "reviewed_without_decision",
      scanId: "stage-b",
    });
    expect(classify([approvedA, review({ id: "stage-b" })])).toMatchObject({
      status: "approved_match",
      scanId: "stage-b",
    });
    expect(classify([approvedA, review({ id: "stage-b", decision: "no_publish" })])).toMatchObject({
      status: "published_despite_rejection",
      scanId: "stage-b",
    });
    const pendingB = inFlight("pending", { id: "stage-b" });
    expect(classify([approvedA, pendingB])).toMatchObject({
      status: "published_without_approval",
      reason: "review_pending",
      scanId: "stage-b",
    });
  });

  test("an attacker's restage that supersedes the approved stage cannot hide other bytes", () => {
    // The owner approved A; an attacker restages the version as B (which
    // supersedes A) and publishes bytes matching neither.
    const attackerB = (status: "pending" | "failed" | "complete") =>
      status === "complete"
        ? review({
            id: "stage-b",
            decision: null,
            decidedAt: null,
            summaryJson: stagedIntegrity(stageSha1),
          })
        : inFlight(status, { id: "stage-b", stagedDeclaredSha1: stageSha1 });
    for (const status of ["pending", "failed", "complete"] as const) {
      expect(classify([approvedA, attackerB(status)]), status).toMatchObject({
        status: "artifact_mismatch",
        scanId: "stage-a",
      });
    }
    // Discovery superseded A but never recorded B.
    expect(classify([approvedA])).toMatchObject({ status: "artifact_mismatch", scanId: "stage-a" });
  });

  test("a superseded approval of the exact published bytes still counts", () => {
    expect(classify([review({ id: "stage-a", ...superseded })])).toMatchObject({
      status: "approved_match",
      scanId: "stage-a",
    });
  });
});

describe("bytes that cannot be hashed", () => {
  test("a padded tarball whose npm shasum matches no review raises the alert", () => {
    expect(
      classifyPublication(name, version, published, "artifact_too_large", [review()], {
        declaredSha1: "e".repeat(40),
      }),
    ).toMatchObject({ status: "artifact_mismatch", scanId: "scan1" });
    expect(
      classifyPublication(
        name,
        version,
        published,
        "artifact_timeout",
        [review({ decision: null, decidedAt: null })],
        { declaredSha1: "e".repeat(40) },
      ).status,
    ).toBe("published_without_approval");
  });

  test("an npm shasum matching an approval stays unknown: the bytes were not hashed here", () => {
    expect(
      classifyPublication(name, version, published, "artifact_too_large", [review()], {
        declaredSha1: sha1,
      }),
    ).toEqual({ status: "unknown", reason: "artifact_too_large", scanId: "scan1" });
  });

  test("an npm shasum matching an undecided or rejected record still alerts", () => {
    const unhashed = (reviews: ReviewEvidence[]) =>
      classifyPublication(name, version, published, "artifact_timeout", reviews, {
        declaredSha1: sha1,
      });
    expect(unhashed([inFlight("pending")])).toEqual({
      status: "published_without_approval",
      reason: "review_pending",
      scanId: "scan1",
    });
    expect(
      unhashed([review({ decision: "no_publish", decidedAt: new Date(published.getTime() + 1) })]),
    ).toMatchObject({
      status: "published_despite_rejection",
      reason: "rejected_after_publication",
    });
  });

  test("a record with no digest does not make the others incomparable", () => {
    expect(
      classifyPublication(
        name,
        version,
        published,
        "artifact_too_large",
        [review(), inFlight("pending", { id: "empty", stagedDeclaredSha1: null })],
        { declaredSha1: "e".repeat(40) },
      ),
    ).toMatchObject({ status: "artifact_mismatch", scanId: "scan1" });
  });

  test("without an npm shasum, or with a gate review's SHA-256 only, it stays unknown", () => {
    expect(classify([review()], "artifact_too_large")).toEqual({
      status: "unknown",
      reason: "artifact_too_large",
      scanId: null,
    });
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
    expect(
      classifyPublication(name, version, published, "artifact_too_large", [gate], {
        declaredSha1: "e".repeat(40),
      }),
    ).toEqual({ status: "unknown", reason: "artifact_too_large", scanId: null });
  });

  test("a gate review that recorded SHA-1 is compared with npm's shasum when padding defeats hashing", () => {
    const gate = review({
      id: "gate",
      source: "workflow_gate",
      registryUrl: null,
      registryPackageName: null,
      registryVersion: null,
      summaryJson: {
        stagedPublish: {
          mode: "workflow_gate",
          digest: sha256,
          sha1,
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
    const padded = (declaredSha1: string) =>
      classifyPublication(name, version, published, "artifact_too_large", [gate], {
        declaredSha1,
      });
    expect(padded("e".repeat(40))).toEqual({
      status: "artifact_mismatch",
      reason: null,
      scanId: "gate",
    });
    expect(padded(sha1)).toEqual({
      status: "unknown",
      reason: "artifact_too_large",
      scanId: "gate",
    });
    // Hashed bytes are matched by SHA-256: a SHA-1 match (a collision) whose
    // SHA-256 differs is not the approved bytes.
    expect(classify([gate])).toMatchObject({ status: "approved_match", scanId: "gate" });
    expect(classify([gate], { sha1, sha256: "d".repeat(64) })).toEqual({
      status: "artifact_mismatch",
      reason: null,
      scanId: "gate",
    });
  });
});

describe("a version with more records than were read", () => {
  const limited = (reviews: ReviewEvidence[], artifact = { sha1, sha256 }) =>
    classifyPublication(name, version, published, artifact, reviews, { historyLimited: true });

  test("a byte match among the newest records still decides", () => {
    expect(limited([review()])).toMatchObject({ status: "approved_match", scanId: "scan1" });
  });

  test("records filtered away entirely still say the history was cut short", () => {
    expect(limited([review({ source: "published" })])).toEqual({
      status: "published_without_approval",
      reason: "review_history_limit",
      scanId: null,
    });
  });

  test("no byte match among them alerts and says the history was cut short", () => {
    expect(limited([review({ decision: null, decidedAt: null })], otherBytes)).toEqual({
      status: "published_without_approval",
      reason: "review_history_limit",
      scanId: null,
    });
    expect(limited([review()], otherBytes)).toEqual({
      status: "artifact_mismatch",
      reason: "review_history_limit",
      scanId: "scan1",
    });
  });
});

describe("decision timing matters only when the bytes match", () => {
  const after = new Date(published.getTime() + 1000);

  test("approving a pending stage after someone else published the version is a mismatch", () => {
    expect(classify([review({ id: "stage-a", decidedAt: after })], otherBytes)).toMatchObject({
      status: "artifact_mismatch",
      scanId: "stage-a",
    });
  });

  test("a late decision on the published bytes themselves stays unknown", () => {
    expect(classify([review({ decidedAt: after })])).toMatchObject({
      status: "unknown",
      reason: "decision_history_unavailable",
    });
  });
});

test("settled unknown causes are the ones another check cannot resolve", () => {
  for (const reason of [
    "decision_history_unavailable",
    "review_digest_unavailable",
    "artifact_too_large",
  ]) {
    expect(isSettledUnknownReason(reason), reason).toBe(true);
  }
  for (const reason of [
    "review_pending",
    "review_failed",
    "reviewed_without_decision",
    "review_history_limit",
    "artifact_timeout",
    null,
  ]) {
    expect(isSettledUnknownReason(reason), String(reason)).toBe(false);
  }
});
