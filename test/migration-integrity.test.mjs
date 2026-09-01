import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Migrations are the one artifact several branches generate concurrently and
// git merges without complaint: `pnpm db:generate` numbers from the current
// tip, so two branches cut from the same commit both produce `00NN_…`. Merging
// them yields two files at the same index, or a journal that lists one of them
// and silently drops the other — and a migration missing from the journal never
// runs against prod, which surfaces as a column that does not exist rather than
// as a merge conflict. Nothing else in the repo reads these files, so only this
// check stands between a bad merge and a broken deploy.

const migrationsDir = fileURLToPath(new URL("../drizzle", import.meta.url));

const MIGRATION_FILE = /^(\d{4})_(.+)\.sql$/;

const sqlFiles = readdirSync(migrationsDir)
  .filter((entry) => entry.endsWith(".sql"))
  .sort();

const journal = JSON.parse(readFileSync(`${migrationsDir}/meta/_journal.json`, "utf8"));

const snapshotIndexes = new Set(
  readdirSync(`${migrationsDir}/meta`)
    .map((entry) => /^(\d{4})_snapshot\.json$/.exec(entry)?.[1])
    .filter(Boolean),
);

describe("drizzle migrations", () => {
  test("every migration file is named <index>_<name>.sql", () => {
    expect(sqlFiles.filter((file) => !MIGRATION_FILE.test(file))).toEqual([]);
  });

  test("no two migrations share an index", () => {
    const byIndex = new Map();
    for (const file of sqlFiles) {
      const index = MIGRATION_FILE.exec(file)?.[1];
      if (index === undefined) continue;
      byIndex.set(index, [...(byIndex.get(index) ?? []), file]);
    }
    const collisions = [...byIndex.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([index, files]) => `${index}: ${files.join(", ")}`);
    expect(
      collisions,
      "Two branches generated a migration at the same index and the merge kept both. " +
        "Renumber the later one with `pnpm db:generate` against the merged schema " +
        "rather than renaming the file, so its journal entry and snapshot move with it.",
    ).toEqual([]);
  });

  test("journal entries are a dense, ordered index sequence", () => {
    expect(journal.entries.map((entry) => entry.idx)).toEqual(
      journal.entries.map((_, index) => index),
    );
  });

  test("each journal entry's tag carries its own index", () => {
    const mismatched = journal.entries
      .filter(
        (entry) =>
          MIGRATION_FILE.exec(`${entry.tag}.sql`)?.[1] !== String(entry.idx).padStart(4, "0"),
      )
      .map((entry) => `idx ${entry.idx} -> ${entry.tag}`);
    expect(mismatched).toEqual([]);
  });

  test("journal and migration files describe the same set", () => {
    const journalTags = journal.entries.map((entry) => `${entry.tag}.sql`).sort();
    expect(
      sqlFiles,
      "A migration file with no journal entry is never applied, and a journal entry " +
        "with no file fails the migration run. Regenerate rather than hand-editing either side.",
    ).toEqual(journalTags);
  });

  test("every journal entry has a schema snapshot", () => {
    const missing = journal.entries
      .filter((entry) => !snapshotIndexes.has(String(entry.idx).padStart(4, "0")))
      .map((entry) => entry.tag);
    expect(
      missing,
      "A migration without a snapshot was hand-written or partially merged; the next " +
        "`pnpm db:generate` diffs against the wrong baseline and emits a wrong migration.",
    ).toEqual([]);
  });
});
