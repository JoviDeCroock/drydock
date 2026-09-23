import type { VNode } from "preact";
import { describe, expect, test } from "vitest";
import type { PackageJsonDiff } from "../server/types";
import { EmptyLine } from "../src/components/Typography";
import { manifestVersionRange, PackageJsonDiffView } from "../src/components/PackageJsonDiffView";

function manifest(overrides: Partial<PackageJsonDiff> = {}): PackageJsonDiff {
  return {
    name: "example",
    hasPreviousManifest: true,
    previousVersion: "1.0.0",
    stagedVersion: "1.0.1",
    scripts: [],
    dependencies: [],
    bin: [],
    entrypointsChanged: false,
    ...overrides,
  };
}

describe("PackageJsonDiffView", () => {
  test("says a release without manifest changes in one line", () => {
    const view = PackageJsonDiffView({ diff: manifest() }) as VNode<{ children: string }>;
    expect(view.type).toBe(EmptyLine);
    expect(view.props.children).toBe("No script, dependency, bin, or entrypoint changes.");
  });

  test("keeps the change lists when any manifest field changed", () => {
    const view = PackageJsonDiffView({
      diff: manifest({ entrypointsChanged: true }),
    }) as VNode;
    expect(view.type).not.toBe(EmptyLine);
  });
});

describe("manifestVersionRange", () => {
  test("names the manifest's own version pair", () => {
    expect(manifestVersionRange(manifest())).toBe("1.0.0 → 1.0.1");
  });

  test("stays silent on a first release instead of printing a placeholder", () => {
    expect(
      manifestVersionRange(manifest({ previousVersion: null, hasPreviousManifest: false })),
    ).toBe(null);
  });
});
