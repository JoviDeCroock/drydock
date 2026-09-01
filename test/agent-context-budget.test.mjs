import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Agent-facing prose has a cost the rest of the repo does not: AGENTS.md and
// every skill `description` load into context on every session, whether or not
// the task touches what they describe. Left alone the file only grows — each
// new rule reads as a small addition, and nothing ever forces the trade against
// what is already there. These ceilings make growth a decision: to add, either
// cut something or raise the number deliberately. They are set close to current
// size on purpose, so headroom is not an invitation.
//
// A rule a lint or test already enforces does not belong in these files at all
// — the build fails on its own, and the prose is pure per-session tax.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const skillsDir = path.join(repoRoot, ".claude/skills");

/** Characters, not bytes: this prose is em-dash heavy and multibyte inflates bytes. */
function size(file) {
  return readFileSync(path.join(repoRoot, file), "utf8").length;
}

const skillDirs = readdirSync(skillsDir).filter((name) => !name.startsWith("."));
const skills = skillDirs.map((name) => `.claude/skills/${name}/SKILL.md`);

// Line-wise rather than one regex: YAML continues a scalar onto indented lines,
// and a regex that stops at the first newline would let a wrapped description
// pass the budget while still costing the full amount in context.
function frontmatterDescription(file) {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(readFileSync(path.join(repoRoot, file), "utf8"));
  if (!frontmatter) return null;
  const lines = frontmatter[1].split("\n");
  const start = lines.findIndex((line) => line.startsWith("description:"));
  if (start === -1) return null;
  const continuation = lines.slice(start + 1);
  const end = continuation.findIndex((line) => /^\S/.test(line));
  return [
    lines[start].slice("description:".length),
    ...(end === -1 ? continuation : continuation.slice(0, end)),
  ]
    .join(" ")
    .trim();
}

describe("agent context budget", () => {
  // Loaded on every session, before the task is known.
  test("AGENTS.md and CLAUDE.md together stay under 4,000 characters", () => {
    expect(size("AGENTS.md") + size("CLAUDE.md")).toBeLessThanOrEqual(4_000);
  });

  test("every skill directory has a SKILL.md", () => {
    expect(skills.filter((skill) => !existsSync(path.join(repoRoot, skill)))).toEqual([]);
  });

  // Loaded when the skill is invoked, so the ceiling is per file, not summed.
  test.each(skills)("%s stays under 8,000 characters", (skill) => {
    expect(size(skill)).toBeLessThanOrEqual(8_000);
  });

  // Every description is in the skill listing on every session, so this is the
  // one skill field with an always-on cost.
  test.each(skills)("%s has a description under 200 characters", (skill) => {
    const description = frontmatterDescription(skill);
    expect(description).not.toBeNull();
    expect(description.length).toBeLessThanOrEqual(200);
  });
});

describe("docs stay reachable", () => {
  // AGENTS.md sends agents to docs/README.md to load context progressively. A
  // doc nothing links to is invisible to that path: it goes stale unread, and
  // the next agent solves from scratch what it already answers. Reachability is
  // transitive — a doc cited by the doc that owns its subject is discoverable.
  test("every docs/ Markdown file is reachable from docs/README.md", () => {
    const docs = new Set(
      readdirSync(path.join(repoRoot, "docs"), { recursive: true })
        .map((entry) => entry.split(path.sep).join("/"))
        .filter((entry) => entry.endsWith(".md")),
    );

    const reachable = new Set();
    const queue = ["README.md"];
    while (queue.length > 0) {
      const current = queue.pop();
      if (reachable.has(current) || !docs.has(current)) continue;
      reachable.add(current);
      const body = readFileSync(path.join(repoRoot, "docs", current), "utf8");
      for (const [, target] of body.matchAll(/\]\(\.?\/?([A-Za-z0-9_./-]+\.md)(?:#[^)]*)?\)/g)) {
        queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(current), target)));
      }
    }

    expect(
      [...docs].filter((doc) => !reachable.has(doc)).sort(),
      "Link it from docs/README.md, or from the doc that owns its subject.",
    ).toEqual([]);
  });
});
