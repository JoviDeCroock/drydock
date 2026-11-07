import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// docs/ is read by agents a row at a time and by humans skimming for a table.
// Left alone it drifts back into multi-kilobyte paragraphs and changelogs that
// every reader pays for: in 2026-11 one architecture.md paragraph was 7 KB and
// half of design.md was a decisions log. These ceilings make that drift a
// decision. Tables and fenced blocks are exempt from the line limit because a
// wide row is still one fact.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const docsDir = path.join(repoRoot, "docs");

const MAX_DOC_CHARS = 40_000;
const MAX_PROSE_LINE_CHARS = 700;

const docs = readdirSync(docsDir, { recursive: true, encoding: "utf8" })
  .map((entry) => entry.split(path.sep).join("/"))
  .filter((entry) => entry.endsWith(".md"))
  .sort();

function read(doc: string): string {
  return readFileSync(path.join(docsDir, doc), "utf8");
}

function proseLines(body: string): Array<{ line: string; number: number }> {
  const lines: Array<{ line: string; number: number }> = [];
  let fenced = false;
  body.split("\n").forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced || /^\s*\|/.test(line)) return;
    lines.push({ line, number: index + 1 });
  });
  return lines;
}

describe("docs shape", () => {
  test.each(docs)(`docs/%s stays under ${MAX_DOC_CHARS} characters`, (doc) => {
    expect(read(doc).length).toBeLessThanOrEqual(MAX_DOC_CHARS);
  });

  test.each(docs)(`docs/%s has no prose line over ${MAX_PROSE_LINE_CHARS} characters`, (doc) => {
    const long = proseLines(read(doc))
      .filter(({ line }) => line.length > MAX_PROSE_LINE_CHARS)
      .map(({ line, number }) => `${doc}:${number} (${line.length} chars)`);
    expect(long, "Split the paragraph or turn the enumeration into a table.").toEqual([]);
  });

  test.each(docs)("docs/%s keeps issue numbers out of headings", (doc) => {
    const headings = read(doc)
      .split("\n")
      .filter((line) => /^#{1,6} /.test(line) && /#\d+|\bissue \d+/i.test(line));
    expect(headings, "History belongs in git or a history doc, not a heading.").toEqual([]);
  });

  // README.md carries the npm gate workflow inline because it is the quick
  // start; four drifting copies in two variants is how this test came about.
  test("README.md npm gate workflow matches docs/examples/npm-workflow-gate.yml", () => {
    const canonical = readFileSync(path.join(docsDir, "examples/npm-workflow-gate.yml"), "utf8");
    const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
    const blocks = [...readme.matchAll(/^( *)```yaml\n([\s\S]*?)^\1```/gm)].map(
      ([, indent, body]) =>
        body
          .split("\n")
          .map((line) => line.slice(indent.length))
          .join("\n"),
    );
    expect(blocks).toContain(canonical);
  });
});
