import { describe, expect, test } from "vitest";
import { h } from "preact";
import { LocationProvider } from "preact-iso";
import prerender, { locationStub } from "preact-iso/prerender";
import report from "../src/features/public-content/incident-benchmark-v1.json";
import BenchmarksPage from "../src/pages/Benchmarks/index";
import InvitePage from "../src/pages/Dashboard/Invite/index";
import type { PublicReport } from "../src/models/public-report";
import { EvidenceOnlyReport, reviewedFromLine } from "../src/pages/PublicReport/index";

describe("public report closing", () => {
  test("names where the reviewed bytes came from for each review source", () => {
    expect(reviewedFromLine("manual")).toContain("npm stage");
    expect(reviewedFromLine("auto_discovery")).toContain("npm stage");
    expect(reviewedFromLine("workflow_gate")).toContain("GitHub workflow uploaded to its gate");
    expect(reviewedFromLine("published")).toContain("the registry serves");
    expect(reviewedFromLine("something_new")).toBe("Drydock reviewed the files in this release.");
  });

  test("never claims a hold, a reading, or a pending decision it cannot establish", () => {
    for (const source of ["manual", "auto_discovery", "workflow_gate", "published", "x"]) {
      expect(reviewedFromLine(source)).not.toMatch(/\b(held|holds|read this|deciding|stopped)\b/i);
    }
  });
});

describe("evidence-only public report", () => {
  const legacy: PublicReport = {
    schema: "drydock.report.v2",
    scan: {
      id: "scan-1",
      status: "completed",
      source: "manual",
      risk: "low",
      decision: "publish",
      createdAt: null,
      completedAt: null,
    },
    package: { name: "left-pad", stagedVersion: "1.1.0", previousVersion: "1.0.0" },
    riskSummary: null,
    diff: [],
    findings: [],
  };

  async function render(authed: boolean, packageDiff: string | null) {
    locationStub("/reports/token");
    const { html } = await prerender(
      h(LocationProvider, null, h(EvidenceOnlyReport, { data: legacy, authed, packageDiff })),
    );
    return html;
  }

  test("puts the package diff beside the notice when the report names its package", async () => {
    const html = await render(false, "/diff/left-pad");
    expect(html).toContain("created before shared file diffs were available");
    expect(html).toMatch(/<a [^>]*href="\/diff\/left-pad"[^>]*>Diff this package<\/a>/);
    expect(html).not.toContain("Open reviews");
  });

  test("sends a signed-in reader to their reviews, not to a guessed scan", async () => {
    const html = await render(true, null);
    expect(html).toMatch(/<a [^>]*href="\/dashboard"[^>]*>Open reviews<\/a>/);
    expect(html).not.toContain("Diff this package");
    expect(html).not.toContain("scan-1");
  });
});

describe("benchmark case summary", () => {
  test("gives narrow screens one stacked entry per case alongside the wide table", async () => {
    locationStub("/benchmarks/shai-hulud-nx");
    const { html } = await prerender(h(LocationProvider, null, h(BenchmarksPage, {})));

    const stacked = html.match(/<ul class="[^"]*sm:hidden[^"]*">([\s\S]*?)<\/ul>/)?.[1];
    expect(stacked).toBeDefined();
    expect(stacked!.match(/<li /g)).toHaveLength(report.cases.length);
    for (const testCase of report.cases) {
      expect(stacked).toContain(`href="#case-${testCase.id}"`);
    }
    expect(html).toMatch(/<div class="[^"]*hidden[^"]*sm:block[^"]*"><table/);
  });
});

describe("invite acceptance", () => {
  test("shows one progress statement while joining", async () => {
    locationStub("/dashboard/invite?token=invite-token");
    const { html } = await prerender(h(LocationProvider, null, h(InvitePage, {})));

    expect(html).toContain("Joining organization");
    expect(html).not.toContain("confirming session");
    expect(html).not.toContain("accepting invitation");
  });
});
