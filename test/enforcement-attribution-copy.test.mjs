import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Drydock enforces no release itself. On a workflow gate, GitHub's
// deployment-protection rule holds the configured job and acts on Drydock's
// answer; on a staged review, npm and its maintainer decide. Copy that makes
// Drydock the subject of the hold ("Drydock blocks the job") claims a control
// another party owns, so it fails here. Say that GitHub holds or blocks the
// job, or that Drydock rejects it, instead.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const DRYDOCK_AS_ENFORCER =
  /\bDrydock (?:holds|blocks|blocked|releases|released|stops|stopped|enforces|enforced) (?:this|the|that|your|a|each|every) (?:(?:configured|protected|held|GitHub|publish|release|waiting) )*(?:job|release|deployment|publish|run|stage)s?\b/gi;

function copyFiles() {
  const tracked = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "README.md",
      "docs",
      "src",
      "server",
      ".agents/product-marketing.md",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);
  return tracked.filter((file) => /\.(?:md|ts|tsx|mjs|js)$/.test(file));
}

describe("enforcement attribution in copy", () => {
  test("never names Drydock as the party that holds or blocks a release", async () => {
    const offenders = [];
    for (const file of copyFiles()) {
      let text;
      try {
        text = await readFile(path.join(repoRoot, file), "utf8");
      } catch {
        continue; // deleted in the working tree but still in the index
      }
      // JSX and Markdown wrap sentences across lines and indentation.
      const flat = text.replace(/\s+/g, " ");
      for (const match of flat.matchAll(DRYDOCK_AS_ENFORCER)) {
        offenders.push(`${file}: "${match[0]}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the pattern catches the phrasings it exists for", () => {
    const samples = [
      "Drydock blocked this release: the artifacts could not be verified.",
      "After every package is approved, Drydock releases the GitHub job.",
      "environment: production # Drydock holds this job",
    ];
    for (const sample of samples) {
      expect(sample.match(DRYDOCK_AS_ENFORCER), sample).not.toBeNull();
    }
    expect(
      "Drydock never holds the credential that publishes it.".match(DRYDOCK_AS_ENFORCER),
    ).toBeNull();
    expect(
      "Drydock rejects the job; GitHub keeps it blocked.".match(DRYDOCK_AS_ENFORCER),
    ).toBeNull();
  });
});
