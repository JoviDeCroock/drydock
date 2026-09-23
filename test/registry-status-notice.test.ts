import { describe, expect, test } from "vitest";
import {
  registryStatusBadge,
  registryStatusNoticeVariant,
  registryStatusVariant,
} from "../src/features/registry-status";
import { releaseAttention } from "../src/features/package-releases";

describe("registry status variant", () => {
  test("npm blocking a version is its own signal, whatever we decided", () => {
    expect(registryStatusVariant({ registryVersionStatus: "blocked" })).toBe("blocked");
    expect(registryStatusVariant({ registryVersionStatus: "blocked", decision: "publish" })).toBe(
      "blocked",
    );
  });

  test("staged is silent until we have approved it", () => {
    // The normal resting state of a release under review. Announcing it on the
    // page reached from the staged list is noise.
    expect(registryStatusVariant({ registryVersionStatus: "staged" })).toBe(null);
    expect(registryStatusVariant({ registryVersionStatus: "staged", decision: "no_publish" })).toBe(
      null,
    );
    expect(registryStatusVariant({ registryVersionStatus: "staged", decision: "publish" })).toBe(
      "awaiting_approval",
    );
  });

  test("an unresolved lookup says nothing at all", () => {
    // npm answers 404 for an unknown version and an unauthorized one alike, so
    // a missing status must never render as reassurance or alarm.
    expect(registryStatusVariant({})).toBe(null);
    expect(registryStatusVariant({ registryVersionStatus: null })).toBe(null);
    expect(registryStatusVariant({ registryVersionStatus: null, decision: "publish" })).toBe(null);
    expect(registryStatusVariant({ registryVersionStatus: "" })).toBe(null);
  });

  test("a status npm has not documented is not guessed at", () => {
    expect(registryStatusVariant({ registryVersionStatus: "quarantined" })).toBe(null);
  });

  test("a superseded review never presents its last registry status as current", () => {
    expect(
      registryStatusVariant({
        registryVersionStatus: "blocked",
        registryStatusSupersededAt: "2026-08-20T10:00:00.000Z",
      }),
    ).toBe(null);
  });

  test("maps the remaining lifecycle states", () => {
    expect(registryStatusVariant({ registryVersionStatus: "validating" })).toBe("validating");
    expect(registryStatusVariant({ registryVersionStatus: "published" })).toBe("published");
    expect(registryStatusVariant({ registryVersionStatus: "deleted" })).toBe("deleted");
  });
});

describe("registry status badge", () => {
  test("names npm in every label, so it is never read as our verdict", () => {
    for (const status of ["blocked", "validating", "published", "deleted"]) {
      const badge = registryStatusBadge({ registryVersionStatus: status });
      expect(badge?.label).toMatch(/^npm /);
    }
    expect(
      registryStatusBadge({ registryVersionStatus: "staged", decision: "publish" })?.label,
    ).toMatch(/^npm /);
  });

  test("colors only the states that ask something of the reader", () => {
    expect(registryStatusBadge({ registryVersionStatus: "blocked" })?.tone).toBe("critical");
    expect(
      registryStatusBadge({ registryVersionStatus: "staged", decision: "publish" })?.tone,
    ).toBe("medium");
    expect(registryStatusBadge({ registryVersionStatus: "validating" })?.tone).toBe(null);
    expect(
      registryStatusBadge({ registryVersionStatus: "deleted", decision: "publish" })?.tone,
    ).toBe(null);
    expect(registryStatusBadge({})).toBe(null);
  });

  test("reads a published version against the decision recorded here", () => {
    expect(
      registryStatusBadge({ registryVersionStatus: "published", decision: "publish" }),
    ).toEqual({ label: "npm published", tone: null });
    expect(registryStatusBadge({ registryVersionStatus: "published" })).toEqual({
      label: "npm published, no decision",
      tone: "medium",
    });
    expect(
      registryStatusBadge({ registryVersionStatus: "published", decision: "no_publish" }),
    ).toEqual({ label: "npm published over a block", tone: "critical" });
  });

  test("describes deleted versions as removed rather than pre-publication withdrawals", () => {
    expect(
      registryStatusBadge({ registryVersionStatus: "deleted", decision: "publish" })?.label,
    ).toBe("npm removed");
    expect(registryStatusBadge({ registryVersionStatus: "deleted" })).toEqual({
      label: "npm removed, no decision",
      tone: "medium",
    });
    expect(
      registryStatusBadge({ registryVersionStatus: "deleted", decision: "no_publish" }),
    ).toEqual({ label: "npm removed, published over a block", tone: "critical" });
  });

  test("reads an outcome a failed review proved, not only npm's reported status", () => {
    expect(registryStatusBadge({ registryReleaseOutcome: "published" })).toEqual({
      label: "npm published, no decision",
      tone: "medium",
    });
    expect(
      registryStatusBadge({
        registryReleaseOutcome: "published",
        registryStatusSupersededAt: 1,
      }),
    ).toBe(null);
  });

  test("tones exactly the releases the package view fills for attention", () => {
    for (const registryVersionStatus of [null, "staged", "published", "deleted", "blocked"]) {
      for (const decision of [null, "publish", "no_publish"]) {
        const release = { registryVersionStatus, decision, registryReleaseOutcome: null };
        const attention = releaseAttention(release);
        const tone = registryStatusBadge(release)?.tone ?? null;
        if (attention === "published_without_review") expect(tone).toBe("medium");
        else if (attention === "published_despite_block") expect(tone).toBe("critical");
        else if (registryVersionStatus !== "blocked" && registryVersionStatus !== "staged") {
          expect(tone).toBe(null);
        }
      }
    }
  });
});

describe("registry status notice", () => {
  test("reserves a separate row for states with actionable context", () => {
    expect(registryStatusNoticeVariant({ registryVersionStatus: "blocked" })).toBe("blocked");
    expect(registryStatusNoticeVariant({ registryVersionStatus: "validating" })).toBe("validating");
    expect(
      registryStatusNoticeVariant({ registryVersionStatus: "staged", decision: "publish" }),
    ).toBe("awaiting_approval");
  });

  test("keeps quiet terminal outcomes in header metadata only", () => {
    expect(registryStatusNoticeVariant({ registryVersionStatus: "published" })).toBe(null);
    expect(registryStatusNoticeVariant({ registryVersionStatus: "deleted" })).toBe(null);
  });
});
