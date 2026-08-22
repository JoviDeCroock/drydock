import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// AGENTS.md: "D1/Better Auth are required for every non-auth `/api/*` endpoint."
// That is enforced structurally rather than per-handler — a single
// `app.use("/api/*")` in server/index.ts rejects any request without a session.
// Hono runs middleware in registration order, so the guarantee is really about
// *position*: a route mounted above that `app.use` never sees it and ships
// anonymous, with nothing in the route file itself to reveal that. This test
// pins both halves — where the guard sits, and which mounts are allowed above it.

const indexSource = readFileSync(
  fileURLToPath(new URL("../server/index.ts", import.meta.url)),
  "utf8",
);

// The Better Auth handler must remain reachable without an existing session.
// docs/security-model.md documents the one non-auth exception under `/api/*`:
// public package diff is credential-free and IP rate-limited. Adding another
// entry here is a security decision, not a test-maintenance formality.
const API_ROUTES_ALLOWED_ABOVE_SESSION_GUARD = ["/api/auth/*", "/api/public/v1/package-diff"];

/** Line number (1-based) of the `app.use("/api/*")` that requires a session. */
function sessionGuardLine(lines) {
  const guard = lines.findIndex(
    (line, index) =>
      line.startsWith('app.use("/api/*"') &&
      // The session guard is the one that 401s on a missing session.
      lines
        .slice(index, index + 6)
        .some((body) => /return c\.json\(\{ error: "unauthorized" \}/.test(body)),
  );
  return guard === -1 ? -1 : guard + 1;
}

function apiMounts(source) {
  const mounts = [];
  const registrations = [
    /^[\t ]*app\.(?:all|delete|get|head|mount|options|patch|post|put|query|route)\s*\(\s*["'](\/api(?:\/[^"']*)?)["']/gm,
    /^[\t ]*app\.on\s*\(\s*(?:\[[^\]]*\]|[^,]+),\s*["'](\/api(?:\/[^"']*)?)["']/gm,
  ];

  for (const registration of registrations) {
    for (const match of source.matchAll(registration)) {
      const before = source.slice(0, match.index);
      mounts.push({ path: match[1], line: before.split("\n").length });
    }
  }
  return mounts.sort((a, b) => a.line - b.line);
}

describe("/api/* auth boundary", () => {
  const lines = indexSource.split("\n");
  const guardLine = sessionGuardLine(lines);

  test("a session guard covers /api/*", () => {
    expect(
      guardLine,
      'server/index.ts must keep an `app.use("/api/*")` that 401s when getAuthSession returns nothing.',
    ).toBeGreaterThan(0);
  });

  test("only auth and the documented public exception mount above the session guard", () => {
    const mounts = apiMounts(indexSource);
    expect(mounts.length).toBeGreaterThan(5);

    const anonymous = mounts.filter((mount) => mount.line < guardLine).map((mount) => mount.path);
    expect(
      anonymous.sort(),
      "A route mounted above the session guard is served anonymously — Hono runs middleware in " +
        "registration order, so the guard never runs for it. Move the mount below the guard, or, " +
        "if it is an auth handler or genuinely credential-free rate-limited public endpoint, " +
        "document it and add it to API_ROUTES_ALLOWED_ABOVE_SESSION_GUARD here.",
    ).toEqual([...API_ROUTES_ALLOWED_ABOVE_SESSION_GUARD].sort());
  });

  test("every route allowed above the guard is actually mounted", () => {
    const mounts = apiMounts(indexSource).map((mount) => mount.path);
    for (const allowed of API_ROUTES_ALLOWED_ABOVE_SESSION_GUARD) {
      expect(
        mounts,
        `${allowed} is allowlisted as anonymous but no longer mounted — drop the stale entry.`,
      ).toContain(allowed);
    }
  });

  test("recognizes direct and method-list API handlers", () => {
    const source = [
      'app.get("/api/direct", handler);',
      'app.post("/api/direct", handler);',
      'app.all("/api/auth/*", handler);',
      'app.mount("/api/mounted", handler);',
      'app.query("/api/queried", handler);',
      'app.on(["PUT", "PATCH"], "/api/method-list", handler);',
    ].join("\n");

    expect(apiMounts(source).map((mount) => mount.path)).toEqual([
      "/api/direct",
      "/api/direct",
      "/api/auth/*",
      "/api/mounted",
      "/api/queried",
      "/api/method-list",
    ]);
  });
});
