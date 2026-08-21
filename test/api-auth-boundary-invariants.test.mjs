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

// docs/security-model.md: exactly two anonymous exceptions, both credential-free
// and IP rate-limited. Only the first is under `/api/*`; `/public/reports/*` is
// mounted outside it. Adding an entry here is a security decision, not a
// formality — it must be credential-free, rate-limited, and documented there.
const ANONYMOUS_API_MOUNTS = ["/api/public/v1/package-diff"];

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

function apiMounts(lines) {
  const mounts = [];
  lines.forEach((line, index) => {
    const match = line.match(/^app\.route\("(\/api\/[^"]*)"/);
    if (match) mounts.push({ path: match[1], line: index + 1 });
  });
  return mounts;
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

  test("only the documented anonymous exceptions mount above the session guard", () => {
    const mounts = apiMounts(lines);
    expect(mounts.length).toBeGreaterThan(5);

    const anonymous = mounts.filter((mount) => mount.line < guardLine).map((mount) => mount.path);
    expect(
      anonymous.sort(),
      "A route mounted above the session guard is served anonymously — Hono runs middleware in " +
        "registration order, so the guard never runs for it. Move the mount below the guard, or, " +
        "if it is genuinely a credential-free rate-limited public endpoint, document it in " +
        "docs/security-model.md and add it to ANONYMOUS_API_MOUNTS here.",
    ).toEqual([...ANONYMOUS_API_MOUNTS].sort());
  });

  test("every documented anonymous mount is actually mounted", () => {
    const mounts = apiMounts(lines).map((mount) => mount.path);
    for (const allowed of ANONYMOUS_API_MOUNTS) {
      expect(
        mounts,
        `${allowed} is allowlisted as anonymous but no longer mounted — drop the stale entry.`,
      ).toContain(allowed);
    }
  });
});
