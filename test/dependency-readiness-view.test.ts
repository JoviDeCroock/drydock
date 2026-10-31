import { describe, expect, test } from "vitest";
import type { DependencyReadinessIssue } from "../server/lib/ecosystems/npm/dependency-readiness";
import {
  dependencyIssueMessage,
  dependencyReadinessApplies,
  dependencyReadinessView,
  dependencyReadinessHeadline,
  dependencyReadinessUnavailableMessage,
  dependencyRecheckLabel,
  dependencySectionLabel,
  uncheckedDependencyLines,
} from "../src/features/dependency-readiness";

const issue = (overrides: Partial<DependencyReadinessIssue>): DependencyReadinessIssue => ({
  name: "b",
  spec: "^2.0.0",
  section: "dependencies",
  kind: "unpublished",
  packageFound: true,
  ...overrides,
});

const checked = (issues: DependencyReadinessIssue[]) => ({
  status: "checked" as const,
  declared: issues.length,
  notRegistry: 0,
  satisfiedByRelease: 0,
  credentialed: true,
  issues,
});

describe("dependencyReadinessApplies", () => {
  test("only while approving still lies ahead", () => {
    const staged = { status: "complete", source: "auto_discovery" };
    expect(dependencyReadinessApplies(staged, null)).toBe(true);
    expect(
      dependencyReadinessApplies({ ...staged, registryVersionStatus: "validating" }, null),
    ).toBe(true);
    expect(
      dependencyReadinessApplies({ ...staged, registryVersionStatus: "published" }, null),
    ).toBe(false);
    expect(dependencyReadinessApplies({ ...staged, registryStatusSupersededAt: 1 }, null)).toBe(
      false,
    );
    expect(dependencyReadinessApplies({ ...staged, status: "running" }, null)).toBe(false);
    expect(dependencyReadinessApplies({ status: "complete", source: "published" }, null)).toBe(
      false,
    );
  });

  test("an npm gate review applies while its deployment is held", () => {
    const gate = (ecosystem?: string) => ({
      status: "complete",
      source: "workflow_gate",
      summaryJson: ecosystem ? { stagedPublish: { provenance: { ecosystem } } } : {},
    });
    expect(dependencyReadinessApplies(gate("npm"), "pending")).toBe(true);
    expect(dependencyReadinessApplies(gate("npm"), "approved")).toBe(false);
    expect(dependencyReadinessApplies(gate("npm"), null)).toBe(false);
    // Neither another ecosystem nor a gate without provenance asks the npm check.
    expect(dependencyReadinessApplies(gate("pypi"), "pending")).toBe(false);
    expect(dependencyReadinessApplies(gate(), "pending")).toBe(false);
  });
});

describe("dependencyReadinessView", () => {
  test("says nothing for a clean or inapplicable check", () => {
    expect(dependencyReadinessView(null)).toBeNull();
    expect(dependencyReadinessView({ status: "not-applicable" })).toBeNull();
    expect(
      dependencyReadinessView({ status: "unavailable", reason: "npm-connection-changed" }),
    ).toBeNull();
    expect(dependencyReadinessView(checked([]))).toBeNull();
  });

  test("required dependencies warn; optional and peer alone inform", () => {
    expect(dependencyReadinessView(checked([issue({})]))?.tone).toBe("warn");
    expect(
      dependencyReadinessView(
        checked([
          issue({ section: "peerDependencies" }),
          issue({ section: "optionalDependencies" }),
        ]),
      )?.tone,
    ).toBe("info");
  });

  test("unchecked dependencies are counted by why, never listed as blocking", () => {
    const view = dependencyReadinessView(
      checked([
        issue({ name: "f", kind: "unchecked", reason: "lookup-failed" }),
        issue({ name: "s", kind: "unchecked", reason: "lookup-skipped" }),
        issue({ name: "l", kind: "unchecked", reason: "lookup-limit" }),
        issue({ name: "u", kind: "unchecked", reason: "unsupported-spec" }),
        issue({ name: "c" }),
      ]),
    );
    expect(view?.blocking.map((i) => i.name)).toEqual(["c"]);
    expect(view).toMatchObject({ failed: 1, skipped: 1, uncheckable: 2 });
  });
});

describe("dependencyRecheckLabel", () => {
  const view = (issues: DependencyReadinessIssue[]) => dependencyReadinessView(checked(issues))!;
  const unchecked = (reason: DependencyReadinessIssue["reason"]) =>
    issue({ kind: "unchecked", reason });

  test("offers the action only when a re-check has something to do", () => {
    expect(dependencyRecheckLabel(view([unchecked("lookup-failed")]))).toBe("Check again");
    expect(dependencyRecheckLabel(view([issue({}), unchecked("lookup-skipped")]))).toBe(
      "Check again",
    );
    expect(dependencyRecheckLabel(view([unchecked("lookup-skipped")]))).toBe("Check the rest");
    expect(dependencyRecheckLabel(view([unchecked("unsupported-spec")]))).toBeNull();
    expect(dependencyRecheckLabel(view([unchecked("lookup-limit")]))).toBeNull();
  });

  test("says each kind of unchecked dependency once", () => {
    expect(
      uncheckedDependencyLines(
        view([
          unchecked("lookup-failed"),
          unchecked("lookup-skipped"),
          unchecked("lookup-skipped"),
        ]),
      ),
    ).toEqual([
      "Could not check 1 dependency against npm.",
      "2 more dependencies not checked yet; each check reads a limited number from npm.",
    ]);
  });
});

describe("dependencyReadinessUnavailableMessage", () => {
  test("a check that could not run says why, unlike a clean one", () => {
    expect(
      dependencyReadinessUnavailableMessage({
        status: "unavailable",
        reason: "report-unavailable",
      }),
    ).toContain("saved report is unavailable");
    expect(
      dependencyReadinessUnavailableMessage({
        status: "unavailable",
        reason: "npm-connection-changed",
      }),
    ).toContain("different registry");
    expect(dependencyReadinessUnavailableMessage(checked([]))).toBeNull();
    expect(dependencyReadinessUnavailableMessage({ status: "not-applicable" })).toBeNull();
  });
});

describe("dependencyIssueMessage", () => {
  test("names the staged version to approve first, by its decision here", () => {
    const staged = (decision: string | null) =>
      issue({
        kind: "staged",
        staged: { scanId: "s", version: "2.0.0", decision, registryVersionStatus: "staged" },
      });
    expect(dependencyIssueMessage(staged(null))).toBe(
      "b@2.0.0 is staged in this organization and not published yet. Approve it first.",
    );
    expect(dependencyIssueMessage(staged("publish"))).toContain("Approve it on npm first");
    expect(dependencyIssueMessage(staged("no_publish"))).toContain("rejected it");
  });

  test("an alias is described by the package it resolves to", () => {
    expect(
      dependencyIssueMessage(issue({ spec: "npm:@scope/real@^2", target: "@scope/real" })),
    ).toBe("No published version of @scope/real matches.");
    expect(dependencyIssueMessage(issue({ packageFound: false }))).toContain("does not list b");
  });

  test("an anonymous read does not blame a token it never used", () => {
    const missing = issue({ packageFound: false });
    expect(dependencyIssueMessage(missing, { credentialed: true })).toContain("token");
    expect(dependencyIssueMessage(missing, { credentialed: false })).toBe(
      "npm does not list b publicly. If it is private, consumers need access to it.",
    );
  });

  test("only a required dependency is said to break the install", () => {
    const required = dependencyReadinessView(checked([issue({})]))!;
    expect(dependencyReadinessHeadline(required)).toEqual({
      title: "1 dependency cannot be installed from npm yet.",
      consequence: "Approved now, this release would fail to install for its users.",
    });
    const optional = dependencyReadinessView(
      checked([
        issue({ section: "optionalDependencies" }),
        issue({ name: "p", section: "peerDependencies" }),
      ]),
    )!;
    expect(dependencyReadinessHeadline(optional).title).toBe(
      "2 optional or peer dependencies cannot be resolved from npm yet.",
    );
    expect(dependencyReadinessHeadline(optional).consequence).not.toContain("fail to install for");
  });

  test("section labels name only the non-default sections", () => {
    expect(dependencySectionLabel(issue({}))).toBeNull();
    expect(dependencySectionLabel(issue({ section: "peerDependencies" }))).toBe("peer");
    expect(dependencySectionLabel(issue({ section: "optionalDependencies" }))).toBe("optional");
  });
});
