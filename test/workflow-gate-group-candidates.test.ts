import { describe, expect, test } from "vitest";
import { WorkflowArtifactError } from "../server/lib/github-app/artifacts";
import {
  buildManifestOrFail,
  groupReleaseCandidates,
} from "../server/lib/workflow-gates/group-candidates";

interface Entry {
  path: string;
  name: string | null;
  version: string | null;
}

function entry(path: string, name: string | null, version: string | null): Entry {
  return { path, name, version };
}

function group(entries: Entry[], allowMultiplePerGroup: boolean) {
  return groupReleaseCandidates(entries, {
    identity(item) {
      if (!item.name || !item.version) {
        throw new WorkflowArtifactError(
          "artifact_identity_missing",
          `${item.path} has no identity`,
        );
      }
      return { key: item.name.toLowerCase(), name: item.name, version: item.version };
    },
    allowMultiplePerGroup,
    duplicateMessage: (identity) => `package ${identity.name} is duplicated`,
    buildManifest: (identity, members) => ({
      package: identity.name,
      version: identity.version,
      paths: members.map((member) => member.path),
    }),
    candidate: (manifest, members) => ({
      ecosystem: "test",
      pipelineInput: { manifest, count: members.length },
      package: { name: manifest.package, version: manifest.version },
    }),
  });
}

describe("groupReleaseCandidates", () => {
  test("one candidate per identity key, in first-seen order", () => {
    const candidates = group(
      [
        entry("a.whl", "Alpha", "1.0.0"),
        entry("b.whl", "beta", "2.0.0"),
        entry("a2.whl", "alpha", "1.0.0"),
      ],
      true,
    );
    expect(candidates.map((candidate) => candidate.package)).toEqual([
      { name: "Alpha", version: "1.0.0" },
      { name: "beta", version: "2.0.0" },
    ]);
    // The manifest keeps the first-seen spelling and every member's path.
    expect(candidates[0].pipelineInput).toEqual({
      manifest: { package: "Alpha", version: "1.0.0", paths: ["a.whl", "a2.whl"] },
      count: 2,
    });
  });

  test("fails closed on a missing identity with the adapter's own message", () => {
    expect(() => group([entry("x.tgz", null, "1.0.0")], false)).toThrow(
      expect.objectContaining({
        code: "artifact_identity_missing",
        message: "x.tgz has no identity",
      }),
    );
  });

  test("rejects a version disagreement within one group, naming the group", () => {
    expect(() =>
      group([entry("a.tgz", "pkg", "1.0.0"), entry("b.tgz", "PKG", "1.0.1")], true),
    ).toThrow(
      expect.objectContaining({
        code: "artifact_identity_inconsistent",
        message: "b.tgz version 1.0.1 disagrees with 1.0.0 for pkg",
      }),
    );
  });

  test("rejects a second artifact per group when only one is allowed", () => {
    expect(() =>
      group([entry("a.tgz", "pkg", "1.0.0"), entry("b.tgz", "pkg", "1.0.0")], false),
    ).toThrow(
      expect.objectContaining({
        code: "artifact_identity_inconsistent",
        message: "package pkg is duplicated",
      }),
    );
  });

  test("the version check runs before the duplicate check", () => {
    expect(() =>
      group([entry("a.tgz", "pkg", "1.0.0"), entry("b.tgz", "pkg", "2.0.0")], false),
    ).toThrow(/disagrees with/);
  });
});

describe("buildManifestOrFail", () => {
  test("passes a valid manifest through", () => {
    expect(buildManifestOrFail(() => ({ ok: true }), "fallback")).toEqual({ ok: true });
  });

  test("wraps a builder error as artifact_identity_missing with its message", () => {
    expect(() =>
      buildManifestOrFail(() => {
        throw new Error("package name is not valid");
      }, "fallback"),
    ).toThrow(
      expect.objectContaining({
        code: "artifact_identity_missing",
        message: "package name is not valid",
      }),
    );
  });

  test("uses the fallback for a non-Error throw", () => {
    expect(() =>
      buildManifestOrFail(() => {
        throw "nope";
      }, "fallback"),
    ).toThrow(expect.objectContaining({ message: "fallback" }));
  });
});
