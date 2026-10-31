import { describe, expect, test } from "vitest";
import type { DependencyReadinessIssue } from "../server/lib/ecosystems/npm/dependency-readiness";
import {
  dependencyIssueMessage,
  dependencyReadinessApplies,
  dependencyReadinessView,
  dependencySectionLabel,
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

  test("a gate review applies while its deployment is held", () => {
    const gate = { status: "complete", source: "workflow_gate" };
    expect(dependencyReadinessApplies(gate, "pending")).toBe(true);
    expect(dependencyReadinessApplies(gate, "approved")).toBe(false);
    expect(dependencyReadinessApplies(gate, null)).toBe(false);
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

  test("unchecked dependencies are counted, never listed as blocking", () => {
    const view = dependencyReadinessView(
      checked([issue({ kind: "unchecked", reason: "lookup-failed" }), issue({ name: "c" })]),
    );
    expect(view?.blocking.map((i) => i.name)).toEqual(["c"]);
    expect(view?.unchecked).toBe(1);
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

  test("section labels name only the non-default sections", () => {
    expect(dependencySectionLabel(issue({}))).toBeNull();
    expect(dependencySectionLabel(issue({ section: "peerDependencies" }))).toBe("peer");
    expect(dependencySectionLabel(issue({ section: "optionalDependencies" }))).toBe("optional");
  });
});
