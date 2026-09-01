import { readFileSync, readdirSync } from "node:fs";
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

const skills = readdirSync(skillsDir)
  .filter((name) => !name.startsWith("."))
  .map((name) => `.claude/skills/${name}/SKILL.md`);

function frontmatterDescription(file) {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(readFileSync(path.join(repoRoot, file), "utf8"));
  const description = /^description:\s*([\s\S]*?)(?=\n\S+:|$)/m.exec(frontmatter?.[1] ?? "");
  return description?.[1].trim() ?? null;
}

describe("agent context budget", () => {
  // Loaded on every session, before the task is known.
  test("AGENTS.md and CLAUDE.md together stay under 5,000 characters", () => {
    expect(size("AGENTS.md") + size("CLAUDE.md")).toBeLessThanOrEqual(5_000);
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
