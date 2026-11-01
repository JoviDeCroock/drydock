import { describe, expect, test } from "vitest";
import type { GatePackageScan, HeldRelease } from "../src/models/github-app";
import {
  heldReleaseLine as lineFor,
  partiallyPublished,
  stageVerificationLine,
} from "../src/pages/Dashboard/ScanDetail/GateDecisionDialog";

const PENDING_SINGLE = { gateStatus: "pending", packageCount: 1 };
const heldReleaseLine = (held: HeldRelease, gate = PENDING_SINGLE) => lineFor(held, gate);

function release(overrides: Partial<HeldRelease> = {}): HeldRelease {
  return {
    ecosystem: "pypi",
    projectName: "demo-package",
    version: "1.2.0",
    index: "https://pypi.org",
    state: "held",
    stateDetail: null,
    expiresAt: null,
    updatedAt: 0,
    ...overrides,
  };
}

describe("held release line", () => {
  test("a held session says approving publishes it", () => {
    expect(heldReleaseLine(release())).toEqual({
      text: "PyPI holds demo-package 1.2.0 on pypi.org",
      badge: null,
      note: "approving publishes it",
    });
    expect(heldReleaseLine(release({ index: "https://test.pypi.org" })).text).toBe(
      "PyPI holds demo-package 1.2.0 on test.pypi.org",
    );
  });

  test("approving publishes only when it completes a pending gate", () => {
    expect(heldReleaseLine(release(), { gateStatus: "pending", packageCount: 3 }).note).toBe(
      "publishes once every package is approved",
    );
    // An automatic block closed the gate: approving can no longer publish it.
    expect(heldReleaseLine(release(), { gateStatus: "rejected", packageCount: 1 }).note).toBe(
      "not published; the gate is closed",
    );
  });

  test("expected states read as plain text", () => {
    for (const state of [
      "staging",
      "publishing",
      "published",
      "canceling",
      "canceled",
      "externally_canceled",
    ] as const) {
      expect(heldReleaseLine(release({ state })).badge).toBeNull();
    }
  });

  test("states that stop or bypass the approval carry a badge and their detail", () => {
    const stale = heldReleaseLine(
      release({ state: "stale", stateDetail: "files changed since review" }),
    );
    expect(stale.badge).toEqual({
      label: "changed since review, cannot publish",
      tone: "critical",
    });
    expect(stale.note).toBe("files changed since review");
    expect(heldReleaseLine(release({ state: "externally_published" })).badge?.label).toBe(
      "published outside Drydock",
    );
    expect(heldReleaseLine(release({ state: "expired" })).badge?.label).toBe("expired");
    expect(heldReleaseLine(release({ state: "error" })).badge?.label).toBe("error");
    expect(heldReleaseLine(release({ state: "token_removed" })).badge?.label).toBe("token removed");
    expect(heldReleaseLine(release({ state: "upload_failed" })).badge).toEqual({
      label: "upload failed, cannot publish",
      tone: "critical",
    });
    expect(heldReleaseLine(release({ state: "superseded" })).badge?.label).toBe(
      "taken over by a later run",
    );
  });

  test("a blocked gate with one project live and one not is partially published", () => {
    const mixed = [
      release({ state: "published" }),
      release({ projectName: "other", state: "error" }),
    ];
    expect(partiallyPublished("rejected", mixed)).toBe(true);
    expect(partiallyPublished("approved", mixed)).toBe(false);
    expect(partiallyPublished("rejected", [release({ state: "published" })])).toBe(false);
    expect(partiallyPublished("rejected", [release({ state: "stale" })])).toBe(false);
  });
});

describe("stage verification line", () => {
  const pkg = (overrides: Partial<GatePackageScan> = {}): GatePackageScan => ({
    scanId: "scan-2",
    packageName: "demo-package",
    version: "1.2.0",
    status: "complete",
    releaseRisk: "low",
    decision: null,
    ...overrides,
  });
  const verification = {
    protocol: "pep694" as const,
    index: "https://test.pypi.org",
    reviewedGateId: "gate-1",
    reviewedScanId: "scan-1",
    files: [
      { filename: "demo_package-1.2.0-py3-none-any.whl", sha256: "a".repeat(64) },
      { filename: "demo_package-1.2.0.tar.gz", sha256: "b".repeat(64) },
    ],
    verifiedAt: "2026-11-01T00:00:00.000Z",
  };

  test("names the package, file count, and preview index, never a stage URL", () => {
    expect(stageVerificationLine(pkg({ stageVerification: verification }))).toBe(
      "demo-package@1.2.0 · 2 files · installable preview on test.pypi.org (stage URL in the stage job)",
    );
  });

  test("a package without a verification has no line", () => {
    expect(stageVerificationLine(pkg())).toBeNull();
    expect(stageVerificationLine(pkg({ stageVerification: null }))).toBeNull();
  });
});
