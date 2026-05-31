import { describe, expect, test } from "vitest";
import { buildAiReviewPayload, createAiReviewTools } from "../server/lib/ai-review-evidence.ts";

const EMPTY_PACKAGE_JSON_DIFF = {
  name: "fixture",
  previousVersion: "1.0.0",
  stagedVersion: "1.0.1",
  scripts: [{ key: "postinstall", status: "added", staged: "node scripts/install" }],
  dependencies: [],
  entrypointsChanged: true,
};

function file(path, textSample) {
  return {
    path,
    size: textSample.length,
    sha256: `sha-${path}`,
    flags: [],
    textSample,
  };
}

function reviewOptions() {
  const packageJson = JSON.stringify(
    {
      name: "fixture",
      version: "1.0.1",
      main: "dist/index.js",
      scripts: { postinstall: "node scripts/install" },
    },
    null,
    2,
  );
  const files = [
    file("package.json", packageJson),
    file("scripts/install.js", "console.log(process.env.NPM_TOKEN);\n"),
    file("dist/index.js", "export const value = 1;\n"),
    file("README.md", "# fixture\n"),
  ];

  return {
    ecosystem: "npm",
    files,
    previousFiles: files,
    diff: [
      {
        path: "package.json",
        status: "modified",
        previousSize: 1,
        stagedSize: packageJson.length,
        previousSha256: "sha-old-package.json",
        stagedSha256: "sha-package.json",
        flags: [],
      },
      {
        path: "scripts/install.js",
        status: "unchanged",
        previousSize: files[1].size,
        stagedSize: files[1].size,
        previousSha256: files[1].sha256,
        stagedSha256: files[1].sha256,
        flags: [],
      },
      {
        path: "dist/index.js",
        status: "unchanged",
        previousSize: files[2].size,
        stagedSize: files[2].size,
        previousSha256: files[2].sha256,
        stagedSha256: files[2].sha256,
        flags: [],
      },
      {
        path: "README.md",
        status: "unchanged",
        previousSize: files[3].size,
        stagedSize: files[3].size,
        previousSha256: files[3].sha256,
        stagedSha256: files[3].sha256,
        flags: [],
      },
    ],
    packageJsonDiff: EMPTY_PACKAGE_JSON_DIFF,
    ruleFindings: [],
    previousVersionAvailable: true,
  };
}

describe("AI review evidence tools", () => {
  test("allow unchanged files newly referenced by package scripts and entrypoints", async () => {
    const tools = createAiReviewTools(reviewOptions(), () => {});

    const scriptFiles = await tools.list_files.execute({ filter: "scripts" });
    expect(scriptFiles.files.map((entry) => entry.path)).toEqual([
      "package.json",
      "scripts/install.js",
    ]);

    const entrypointFiles = await tools.list_files.execute({ filter: "entrypoints" });
    expect(entrypointFiles.files.map((entry) => entry.path)).toEqual(["dist/index.js"]);

    const reads = await tools.read.execute({
      paths: ["scripts/install.js", "README.md"],
      maxChars: 200,
    });
    expect(reads.ok).toBe(true);
    expect(reads.results).toHaveLength(2);

    const script = reads.results[0];
    expect(script.ok).toBe(true);
    expect(script.status).toBe("unchanged");
    expect(script.kind).toBe("text");
    expect(script.content).toContain("process.env.NPM_TOKEN");

    const readme = reads.results[1];
    expect(readme.ok).toBe(false);
  });

  test("returns a unified diff for changed files when previous text is available", async () => {
    const options = reviewOptions();
    options.previousFiles = options.previousFiles.map((file) =>
      file.path === "package.json" ? { ...file, textSample: '{"name":"fixture"}' } : file,
    );
    const tools = createAiReviewTools(options, () => {});

    const reads = await tools.read.execute({ paths: ["package.json"], maxChars: 4_000 });
    const entry = reads.results[0];
    expect(entry.ok).toBe(true);
    expect(entry.kind).toBe("diff");
    expect(entry.content).toMatch(/^[+\- ]/m);
  });

  test("runs multiple literal searches in one call", async () => {
    const tools = createAiReviewTools(reviewOptions(), () => {});

    const response = await tools.search_files.execute({
      queries: ["NPM_TOKEN", "postinstall"],
      maxResults: 5,
    });
    expect(response.ok).toBe(true);
    expect(response.results.map((entry) => entry.query)).toEqual(["NPM_TOKEN", "postinstall"]);
    const tokenHit = response.results[0];
    expect(tokenHit.ok).toBe(true);
    expect(tokenHit.matches.some((match) => match.path === "scripts/install.js")).toBe(true);
  });

  test("divides the read budget fairly so later batched paths are not starved", async () => {
    const paths = ["a.js", "b.js", "c.js", "d.js"];
    const files = paths.map((path) => file(path, `${path}:`.padEnd(10_000, "x") + "\n"));
    const options = {
      ecosystem: "npm",
      files,
      previousFiles: [],
      diff: paths.map((path, index) => ({
        path,
        status: "added",
        stagedSize: files[index].size,
        stagedSha256: files[index].sha256,
        flags: [],
      })),
      packageJsonDiff: EMPTY_PACKAGE_JSON_DIFF,
      ruleFindings: [],
      previousVersionAvailable: false,
    };
    const tools = createAiReviewTools(options, () => {});

    const reads = await tools.read.execute({ paths, maxChars: 16_000 });
    expect(reads.results).toHaveLength(4);
    for (const entry of reads.results) {
      expect(entry.ok).toBe(true);
      expect(entry.content.length).toBeGreaterThan(1_000);
    }
  });

  test("describes package-json-referenced evidence in the initial payload policy", () => {
    const payload = buildAiReviewPayload(reviewOptions());

    expect(payload.toolPolicy.toolsMayRead).toContain(
      "manifest-referenced script/entrypoint files",
    );
    expect(payload.changedFileManifest.map((entry) => entry.path)).toEqual(["package.json"]);
  });

  test("labels PyPI review payloads with the ecosystem-specific task", () => {
    const payload = buildAiReviewPayload({
      ...reviewOptions(),
      ecosystem: "pypi",
      files: [
        file(
          "wheel/py3-none-any/.dist-info/METADATA",
          "Name: fixture\nVersion: 1.0.1\nRequires-Dist: requests\n",
        ),
      ],
      previousFiles: [],
      diff: [
        {
          path: "wheel/py3-none-any/.dist-info/METADATA",
          status: "added",
          stagedSize: 56,
          stagedSha256: "sha-wheel-metadata",
          flags: [],
        },
      ],
      packageJsonDiff: {
        name: "fixture",
        previousVersion: "1.0.0",
        stagedVersion: "1.0.1",
        scripts: [],
        dependencies: [],
        entrypointsChanged: false,
      },
    });

    expect(payload.ecosystem).toBe("pypi");
    expect(payload.task).toContain("PyPI release candidate");
    expect(payload.task).toContain("workflow gate");
    expect(payload.packageJson).toBeNull();
  });
});
