import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    ARTIFACTS: R2Bucket;
    TEST_MIGRATIONS: D1Migration[];
  }
}

// Pool workers are reused across test files (isolate: false in
// vitest.config.ts), so D1/R2 state persists between files that run on
// the same worker. Files on a worker run sequentially, so resetting storage
// here restores the per-file clean-database semantics the tests are written
// against while keeping the (expensive) module graph warm.
async function resetStorage(): Promise<void> {
  const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{
    name: string;
  }>();
  const userTables = tables.results
    .map((table) => table.name)
    .filter(
      (name) => !name.startsWith("sqlite_") && !name.startsWith("_cf") && name !== "d1_migrations",
    );
  if (userTables.length > 0) {
    await env.DB.batch([
      env.DB.prepare("PRAGMA defer_foreign_keys = true"),
      ...userTables.map((name) => env.DB.prepare(`DELETE FROM "${name}"`)),
    ]);
  }

  let cursor: string | undefined;
  do {
    const listed = await env.ARTIFACTS.list({ cursor });
    if (listed.objects.length > 0) {
      await env.ARTIFACTS.delete(listed.objects.map((object) => object.key));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
}

beforeAll(async () => {
  await resetStorage();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
