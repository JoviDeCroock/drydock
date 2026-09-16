import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));

// Fixtures that every worker suite needs live in one place. A suite that
// re-implements one drifts from the shared shape (audit item B4: 26 copies of
// seedUser, 5 of a hand-rolled zip writer) and hides which fixture a test
// actually depends on.
const SHARED_ONLY = [
  { name: "seedUser", home: "test/workers/helpers/seed.ts" },
  { name: "buildTestApp", home: "test/workers/helpers/app.ts" },
  { name: "makeZip", home: "test/helpers/archive-fixtures (buildZip)" },
  { name: "crc32", home: "test/helpers/archive-fixtures (buildZip)" },
];

const HELPER_DIRS = ["helpers", path.join("workers", "helpers")];

function listTestFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "fixtures" || entry === "e2e-fixtures") continue;
      out.push(...listTestFiles(full));
    } else if (/\.test\.(ts|mjs)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("test helper invariants", () => {
  const files = listTestFiles(TEST_DIR);

  test("scans the suite tree", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  for (const { name, home } of SHARED_ONLY) {
    test(`\`function ${name}(\` is only defined under a helpers directory (${home})`, () => {
      const pattern = new RegExp(
        `^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`,
        "m",
      );
      const offenders = files
        .filter((file) => !HELPER_DIRS.some((dir) => file.includes(`${path.sep}${dir}${path.sep}`)))
        .filter((file) => pattern.test(readFileSync(file, "utf8")))
        .map((file) => path.relative(TEST_DIR, file));
      expect(offenders).toEqual([]);
    });
  }
});
