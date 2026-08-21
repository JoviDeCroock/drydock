import { describe, expect, it } from "vitest";
import {
  MAX_WORKFLOW_BYTES,
  WorkflowYamlError,
  parseWorkflowYaml,
} from "../server/lib/release-authority/yaml";

describe("parseWorkflowYaml", () => {
  it("parses a realistic release workflow", () => {
    const doc = parseWorkflowYaml(`
name: Release
on:
  push:
    tags:
      - "v*"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Build
        run: |
          python -m build
          ls dist
      - uses: actions/upload-artifact@v4
        with:
          name: pypi-release-candidate
          path: dist/*
  publish:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: pypi
      url: https://pypi.org/p/example
    permissions:
      id-token: write
    steps:
      - uses: actions/download-artifact@v4
      - uses: pypa/gh-action-pypi-publish@release/v1
`).value as Record<string, unknown>;

    expect(doc.name).toBe("Release");
    expect(doc.on).toEqual({ push: { tags: ["v*"] }, workflow_dispatch: null });
    expect(doc.permissions).toEqual({ contents: "read" });

    const jobs = doc.jobs as Record<string, Record<string, unknown>>;
    expect(Object.keys(jobs)).toEqual(["build", "publish"]);
    expect(jobs.build.steps).toEqual([
      { uses: "actions/checkout@v4", with: { "fetch-depth": "0" } },
      { name: "Build", run: "python -m build\nls dist\n" },
      {
        uses: "actions/upload-artifact@v4",
        with: { name: "pypi-release-candidate", path: "dist/*" },
      },
    ]);
    expect(jobs.publish.environment).toEqual({ name: "pypi", url: "https://pypi.org/p/example" });
    expect(jobs.publish.permissions).toEqual({ "id-token": "write" });
  });

  it("keeps `on` a string key rather than YAML 1.1's boolean", () => {
    const doc = parseWorkflowYaml("on: [push, workflow_dispatch]").value as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(["on"]);
    expect(doc.on).toEqual(["push", "workflow_dispatch"]);
  });

  it("accepts a sequence at the key's own indent", () => {
    const doc = parseWorkflowYaml(`
on:
  push:
    branches:
    - main
    - release/*
`).value as Record<string, Record<string, Record<string, unknown>>>;
    expect(doc.on.push.branches).toEqual(["main", "release/*"]);
  });

  it("strips comments outside quotes and keeps them inside", () => {
    const doc = parseWorkflowYaml(`
runs-on: ubuntu-latest # the runner
run: echo "# not a comment"
ref: refs/tags/v1#fragment
`).value as Record<string, unknown>;
    expect(doc["runs-on"]).toBe("ubuntu-latest");
    expect(doc.run).toBe('echo "# not a comment"');
    expect(doc.ref).toBe("refs/tags/v1#fragment");
  });

  it("does not split a colon that is not followed by whitespace", () => {
    const doc = parseWorkflowYaml(`
image: ghcr.io/owner/repo:tag
run: curl https://example.test/x
`).value as Record<string, unknown>;
    expect(doc.image).toBe("ghcr.io/owner/repo:tag");
    expect(doc.run).toBe("curl https://example.test/x");
  });

  it("reads block scalars with chomping indicators", () => {
    const doc = parseWorkflowYaml(`
clip: |
  one
  two
strip: |-
  one
  two
fold: >-
  one
  two
`).value as Record<string, unknown>;
    expect(doc.clip).toBe("one\ntwo\n");
    expect(doc.strip).toBe("one\ntwo");
    expect(doc.fold).toBe("one two");
  });

  it("preserves relative indentation inside a block scalar", () => {
    const doc = parseWorkflowYaml(`
run: |
  if true; then
    echo nested
  fi
`).value as Record<string, unknown>;
    expect(doc.run).toBe("if true; then\n  echo nested\nfi\n");
  });

  it("parses flow collections including nested maps", () => {
    const doc = parseWorkflowYaml(`
permissions: {}
matrix: { os: [ubuntu-latest, macos-latest], python: ["3.12"] }
`).value as Record<string, unknown>;
    expect(doc.permissions).toEqual({});
    expect(doc.matrix).toEqual({
      os: ["ubuntu-latest", "macos-latest"],
      python: ["3.12"],
    });
  });

  it("parses unquoted URL values inside flow mappings", () => {
    const doc = parseWorkflowYaml(`
with: { attestations: true, repository-url: https://upload.pypi.org/legacy/ }
`).value as Record<string, unknown>;
    expect(doc.with).toEqual({
      attestations: "true",
      "repository-url": "https://upload.pypi.org/legacy/",
    });
  });

  it("unquotes single and double quoted scalars", () => {
    const doc = parseWorkflowYaml(`
single: 'it''s fine'
double: "line\\nbreak"
key with spaces: plain
"quoted-key": value
`).value as Record<string, unknown>;
    expect(doc.single).toBe("it's fine");
    expect(doc.double).toBe("line\nbreak");
    expect(doc["key with spaces"]).toBe("plain");
    expect(doc["quoted-key"]).toBe("value");
  });

  it("decodes the complete YAML double-quoted escape set", () => {
    const doc = parseWorkflowYaml(
      'unicode: "prod\\u0075ction"\nhex: "\\x41"\nemoji: "\\U0001F680"\nspace: "a\\ b"\n',
    ).value as Record<string, unknown>;

    expect(doc).toMatchObject({
      unicode: "production",
      hex: "A",
      emoji: "🚀",
      space: "a b",
    });
  });

  it.each(['bad: "\\q"\n', 'bad: "\\u12"\n', 'bad: "\\U00110000"\n'])(
    "rejects unsupported or invalid double-quoted escapes",
    (source) => {
      expect(() => parseWorkflowYaml(source)).toThrow(
        expect.objectContaining({ code: "unsupported_syntax" }),
      );
    },
  );

  it("keeps a quoted merge-looking key as ordinary text", () => {
    const doc = parseWorkflowYaml('"<<": value\nflow: { "<<": value }\n').value as Record<
      string,
      unknown
    >;
    expect(doc["<<"]).toBe("value");
    expect(doc.flow).toEqual({ "<<": "value" });
  });

  it("keeps __proto__ as an enumerable mapping key", () => {
    const parsed = parseWorkflowYaml(`
jobs:
  __proto__:
    environment: production
    steps:
      - run: npm publish
`);
    const doc = parsed.value as Record<string, Record<string, unknown>>;
    const jobs = doc.jobs as Record<string, Record<string, unknown>>;

    expect(parsed.complete).toBe(true);
    expect(Object.keys(jobs)).toEqual(["__proto__"]);
    expect(jobs.__proto__.environment).toBe("production");
  });

  it("reads only the first document of a stream", () => {
    const doc = parseWorkflowYaml(`
---
name: first
---
name: second
`).value as Record<string, unknown>;
    expect(doc).toEqual({ name: "first" });
  });

  it("returns null for an empty or comment-only document", () => {
    expect(parseWorkflowYaml("")).toEqual({ value: null, complete: true });
    expect(parseWorkflowYaml("# just a comment\n\n")).toEqual({ value: null, complete: true });
  });

  it("normalizes tab indentation instead of failing", () => {
    const doc = parseWorkflowYaml("jobs:\n\tbuild:\n\t\truns-on: ubuntu-latest\n").value as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    expect(doc.jobs.build["runs-on"]).toBe("ubuntu-latest");
  });

  it("rejects documents past the size limit", () => {
    const oversized = `name: x\n${"# pad\n".repeat(MAX_WORKFLOW_BYTES)}`;
    expect(() => parseWorkflowYaml(oversized)).toThrow(WorkflowYamlError);
  });

  it("rejects an oversized inline value instead of silently comparing its prefix", () => {
    const oversized = `run: npm publish --tag ${"x".repeat(9_000)}\n`;

    expect(() => parseWorkflowYaml(oversized)).toThrow(
      expect.objectContaining({ code: "too_large" }),
    );
  });

  it.each([
    ["anchor", "defaults: &defaults value\n"],
    ["alias", "permissions: *defaults\n"],
    ["tag", "permissions: !custom value\n"],
    ["merge key", "permissions:\n  <<: *defaults\n"],
    ["flow merge key", "permissions: { <<: *defaults }\n"],
  ])("rejects unsupported YAML %s instead of reporting complete coverage", (_label, source) => {
    expect(() => parseWorkflowYaml(source)).toThrow(
      expect.objectContaining({ code: "unsupported_syntax" }),
    );
  });

  it("rejects documents nested past the depth limit", () => {
    let doc = "";
    for (let depth = 0; depth < 40; depth += 1) {
      doc += `${" ".repeat(depth * 2)}k${depth}:\n`;
    }
    expect(() => parseWorkflowYaml(doc)).toThrow(WorkflowYamlError);
  });

  it("reports incomplete rather than silently dropping unreadable input", () => {
    // This reader is deliberately stricter than GitHub's. When it cannot reach
    // the end of a document it must say so — a dropped `publish:` job would
    // otherwise read as "no authority change".
    const parsed = parseWorkflowYaml(`
jobs:
  build:
    steps:
      - uses: a@v1
    ][}{
  publish:
    runs-on: ubuntu-latest
`);
    expect(parsed.complete).toBe(false);
    const doc = parsed.value as Record<string, Record<string, Record<string, unknown>>>;
    expect(doc.jobs.build.steps).toEqual([{ uses: "a@v1" }]);
  });

  it("rejects a malformed flow collection instead of treating it as a complete scalar", () => {
    expect(() => parseWorkflowYaml("permissions: { contents: read\n")).toThrow(
      expect.objectContaining({ code: "unsupported_syntax" }),
    );
  });

  it("reports complete for a document it fully consumed", () => {
    expect(parseWorkflowYaml("on: push\njobs:\n  a:\n    runs-on: x\n").complete).toBe(true);
  });
});
