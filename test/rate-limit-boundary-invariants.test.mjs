import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// AGENTS.md: "`rate-limit.ts` is the only rate limiter: native Cloudflare
// bindings first, D1 only for unsupported windows." A second limiter is easy to
// add by accident — a route that needs a window the shared helper does not
// offer can reach for the `RATE_LIMIT_*` binding or the `rate_limits` table
// directly, and it works, so nothing surfaces it. What is lost is the property
// the single implementation provides: one place decides native-vs-D1, and one
// place knows every configured tier. This pins the single owner, and pins the
// tier table against the two configs that have to declare it.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const OWNER = "server/lib/platform/rate-limit.ts";

// The binding names appear in their own declaration and in the owner's tier
// table; anywhere else is a second limiter.
const DECLARATION_SITES = new Set(["server/env.d.ts", OWNER]);

function read(file) {
  return readFileSync(`${repoRoot}/${file}`, "utf8");
}

// Walks the filesystem rather than `git ls-files`: a new limiter is a new,
// still-untracked file at the moment `pnpm run verify` runs, and that is the
// moment the check is supposed to fire.
function sources(dir = "server") {
  return readdirSync(`${repoRoot}/${dir}`, { withFileTypes: true }).flatMap((entry) => {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sources(file);
    return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [file] : [];
  });
}

/** wrangler.jsonc carries `//` comments; everything else in it is plain JSON. */
function parseJsonc(file) {
  return JSON.parse(read(file).replace(/^\s*\/\/.*$/gm, ""));
}

const nativeTiers = [
  ...read(OWNER)
    .match(/NATIVE_TIERS[\s\S]*?\n\];/)[0]
    .matchAll(/\{\s*limit:\s*(\d+),\s*binding:\s*"(RATE_LIMIT_\w+)"\s*\}/g),
].map(([, limit, binding]) => ({ limit: Number(limit), binding }));

describe("rate limiting has one owner", () => {
  test("the tier table parsed for these assertions is not empty", () => {
    expect(nativeTiers.length).toBeGreaterThan(0);
  });

  test("no module outside the limiter names a RATE_LIMIT_* binding", () => {
    const offenders = sources().filter(
      (file) => !DECLARATION_SITES.has(file) && /\bRATE_LIMIT_\w*_PER_MINUTE\b/.test(read(file)),
    );
    expect(
      offenders,
      "Call enforceRateLimit() from server/lib/platform/rate-limit.ts instead of reaching " +
        "for the binding — it is what decides native-vs-D1 and warns on an unconfigured tier.",
    ).toEqual([]);
  });

  test("no module outside the limiter queries the rate_limits table", () => {
    const offenders = sources().filter(
      (file) =>
        file !== OWNER && file !== "server/db/schema.ts" && /\brateLimits\b/.test(read(file)),
    );
    expect(offenders).toEqual([]);
  });
});

describe("native tiers stay declared everywhere they are needed", () => {
  test("every tier is declared as an optional binding in server/env.d.ts", () => {
    const env = read("server/env.d.ts");
    const missing = nativeTiers
      .map((tier) => tier.binding)
      .filter((binding) => !new RegExp(`\\b${binding}\\?:\\s*RateLimit\\b`).test(env));
    expect(missing).toEqual([]);
  });

  test("wrangler.jsonc declares exactly the tiers the limiter uses, at a 60s period", () => {
    const declared = (parseJsonc("wrangler.jsonc").ratelimits ?? []).map((entry) => ({
      limit: entry.simple?.limit,
      binding: entry.name,
    }));
    expect(
      declared,
      "A tier in NATIVE_TIERS with no ratelimits entry silently degrades every caller at " +
        "that limit to the D1 counter, and a ratelimits entry with no tier is dead config.",
    ).toEqual(nativeTiers);

    const periods = (parseJsonc("wrangler.jsonc").ratelimits ?? []).map(
      (entry) => entry.simple?.period,
    );
    expect(new Set(periods)).toEqual(new Set([60]));
  });
});
