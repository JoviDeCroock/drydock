import { describe, expect, test } from "vitest";
import type { PublicReport } from "../src/models/public-report";
import { reportDiffHref } from "../src/pages/PublicReport/diff-link";

function report(overrides: {
  source?: string;
  name?: string | null;
  previousVersion?: string | null;
  stagedVersion?: string | null;
  provenance?: PublicReport["provenance"];
  registryStatus?: PublicReport["registryStatus"];
}): PublicReport {
  return {
    schema: "drydock.report.v2",
    scan: {
      id: "scan_1",
      status: "complete",
      source: overrides.source ?? "manual",
      risk: "low",
      decision: null,
      createdAt: null,
      completedAt: null,
    },
    package: {
      name: overrides.name === undefined ? "@acme/widget" : overrides.name,
      previousVersion:
        overrides.previousVersion === undefined ? "1.0.0" : overrides.previousVersion,
      stagedVersion: overrides.stagedVersion === undefined ? "1.1.0" : overrides.stagedVersion,
    },
    provenance: overrides.provenance ?? null,
    registryStatus: overrides.registryStatus ?? null,
    riskSummary: null,
    diff: null,
    findings: [],
  };
}

describe("reportDiffHref", () => {
  test("opens the reviewed pair once the registry serves the reviewed version", () => {
    expect(reportDiffHref(report({ registryStatus: { status: "published" } }))).toEqual({
      href: "/diff/@acme/widget/1.0.0/1.1.0",
      specific: true,
    });
  });

  test("opens the package page while the candidate is not on the registry", () => {
    expect(reportDiffHref(report({ registryStatus: { status: "staged" } })).href).toBe(
      "/diff/@acme/widget",
    );
    expect(reportDiffHref(report({ source: "auto_discovery" })).href).toBe("/diff/@acme/widget");
  });

  test("names the gate's declared ecosystem", () => {
    expect(
      reportDiffHref(
        report({ source: "workflow_gate", name: "requests", provenance: { ecosystem: "pypi" } }),
      ).href,
    ).toBe("/diff/pypi/requests");
  });

  test("falls back to the diff tool when no public diff can name the package", () => {
    for (const input of [
      report({ source: "workflow_gate", provenance: { ecosystem: "vscode" } }),
      report({ source: "workflow_gate" }),
      report({ source: "published_pair" }),
      report({ name: null }),
    ]) {
      expect(reportDiffHref(input)).toEqual({ href: "/diff", specific: false });
    }
  });
});
