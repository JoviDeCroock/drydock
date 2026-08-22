import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { tokenizeJs } from "../server/lib/platform/js-lexer";
import { sanitizeJsSource } from "./helpers/sanitized-source.mjs";

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

// Preserve route and error-message strings while removing comments, templates,
// and regex literals. A disabled guard left inside a block comment must not
// satisfy the same structural check that is meant to prove it is executable.
function sanitizeApiSource(source) {
  return sanitizeJsSource(source, () => true);
}

const structuralIndexSource = sanitizeApiSource(indexSource);

// The Better Auth handler must remain reachable without an existing session.
// docs/security-model.md documents the one non-auth exception under `/api/*`:
// public package diff is credential-free and IP rate-limited. Adding another
// entry here is a security decision, not a test-maintenance formality.
const API_REGISTRATIONS_ALLOWED_ABOVE_SESSION_GUARD = [
  { method: "route", path: "/api/public/v1/package-diff" },
  { method: "use", path: "/api/*" },
  { method: "use", path: "/api/*" },
  { method: "use", path: "/api/auth/*" },
  { method: "all", path: "/api/auth/*" },
];

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

function apiRegistrations(source) {
  const registrationMethods = new Set([
    "all",
    "basePath",
    "delete",
    "get",
    "head",
    "mount",
    "on",
    "options",
    "patch",
    "post",
    "put",
    "query",
    "route",
    "use",
  ]);
  const tokens = tokenizeJs(source, { sourceGoal: "module" }).filter(
    (token) => token.type !== "ws" && token.type !== "comment",
  );
  const registrationsFound = [];

  const tokenText = (token) => (token ? source.slice(token.start, token.end) : "");

  function callAt(methodIndex) {
    const openIndex = methodIndex + 1;
    if (tokenText(tokens[openIndex]) !== "(") return null;

    const args = [[]];
    const delimiters = ["("];
    const matchingOpen = { ")": "(", "]": "[", "}": "{" };
    for (let index = openIndex + 1; index < tokens.length; index++) {
      const token = tokens[index];
      const text = tokenText(token);
      if (text === "(" || text === "[" || text === "{") {
        delimiters.push(text);
        args[args.length - 1].push(token);
        continue;
      }
      if (text === ")" || text === "]" || text === "}") {
        if (delimiters[delimiters.length - 1] !== matchingOpen[text]) return null;
        delimiters.pop();
        if (delimiters.length === 0) return { args, endIndex: index };
        args[args.length - 1].push(token);
        continue;
      }
      if (text === "," && delimiters.length === 1) {
        args.push([]);
        continue;
      }
      args[args.length - 1].push(token);
    }
    return null;
  }

  for (let index = 0; index < tokens.length - 3; index++) {
    if (
      tokens[index].type !== "ident" ||
      tokenText(tokens[index]) !== "app" ||
      tokenText(tokens[index + 1]) !== "."
    ) {
      continue;
    }

    let methodIndex = index + 2;
    while (methodIndex < tokens.length) {
      const method = tokenText(tokens[methodIndex]);
      if (tokens[methodIndex].type !== "ident" || !registrationMethods.has(method)) break;
      const call = callAt(methodIndex);
      if (!call) break;

      const pathArgument = call.args[method === "on" ? 1 : 0] ?? [];
      const pathToken = pathArgument.length === 1 ? pathArgument[0] : undefined;
      registrationsFound.push({
        method,
        // A registration above the guard whose path is not a string literal is
        // security-relevant but cannot be classified statically, so keep it as
        // unresolved and make the boundary assertion fail closed below.
        path: pathToken?.type === "string" ? pathToken.value : null,
        line: source.slice(0, tokens[methodIndex].start).split("\n").length,
      });

      const dot = tokens[call.endIndex + 1];
      if (tokenText(dot) !== ".") {
        index = call.endIndex;
        break;
      }
      methodIndex = call.endIndex + 2;
    }
  }
  return registrationsFound.sort((a, b) => a.line - b.line);
}

describe("/api/* auth boundary", () => {
  const lines = structuralIndexSource.split("\n");
  const guardLine = sessionGuardLine(lines);

  test("a session guard covers /api/*", () => {
    expect(
      guardLine,
      'server/index.ts must keep an `app.use("/api/*")` that 401s when getAuthSession returns nothing.',
    ).toBeGreaterThan(0);
  });

  test("only auth and the documented public exception mount above the session guard", () => {
    const registrations = apiRegistrations(structuralIndexSource);
    expect(registrations.length).toBeGreaterThan(5);

    const anonymous = registrations
      .filter(
        (registration) =>
          registration.line < guardLine &&
          (registration.path === null || registration.path.startsWith("/api")),
      )
      .map(({ method, path }) => ({ method, path }));
    expect(
      anonymous,
      "An API registration above the session guard can serve anonymously — Hono runs handlers " +
        "and middleware in registration order, and app.use() may return without calling next(). " +
        "Use a string-literal path so this check can classify it, move it below the guard, or " +
        "review it as auth/bootstrap middleware or a genuinely credential-free rate-limited " +
        "public endpoint and pin it here.",
    ).toEqual(API_REGISTRATIONS_ALLOWED_ABOVE_SESSION_GUARD);
  });

  test("every registration allowed above the guard is actually present", () => {
    const registrations = apiRegistrations(structuralIndexSource).map(({ method, path }) => ({
      method,
      path,
    }));
    for (const allowed of API_REGISTRATIONS_ALLOWED_ABOVE_SESSION_GUARD) {
      expect(
        registrations,
        `${allowed.method} ${allowed.path} is allowlisted above the guard but no longer registered — drop the stale entry.`,
      ).toContainEqual(allowed);
    }
  });

  test("recognizes direct and method-list API handlers", () => {
    const source = [
      'app.get("/api/direct", handler);',
      'app.post("/api/direct", handler);',
      'app.all("/api/auth/*", handler);',
      'app.mount("/api/mounted", handler);',
      'app.query("/api/queried", handler);',
      'app.use("/api/middleware", handler);',
      'app.on(["PUT", "PATCH"], "/api/method-list", handler);',
      'app.use("*", handler).get("/api/chained", handler);',
    ].join("\n");

    expect(apiRegistrations(source).map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "get", path: "/api/direct" },
      { method: "post", path: "/api/direct" },
      { method: "all", path: "/api/auth/*" },
      { method: "mount", path: "/api/mounted" },
      { method: "query", path: "/api/queried" },
      { method: "use", path: "/api/middleware" },
      { method: "on", path: "/api/method-list" },
      { method: "use", path: "*" },
      { method: "get", path: "/api/chained" },
    ]);
  });

  test("fails closed on API registrations whose paths cannot be resolved", () => {
    const source = [
      'const apiPrefix = "/api/private";',
      "app.route(apiPrefix, handler);",
      "app.route(`/api/template`, handler);",
      'app.on("GET", ["/api/one", "/api/two"], handler);',
      'app.basePath("/api").get("/private", handler);',
    ].join("\n");

    expect(
      apiRegistrations(sanitizeApiSource(source)).map(({ method, path }) => ({ method, path })),
    ).toEqual([
      { method: "route", path: null },
      { method: "route", path: null },
      { method: "on", path: null },
      { method: "basePath", path: "/api" },
      { method: "get", path: "/private" },
    ]);
  });

  test("ignores API registrations and session guards inside comments", () => {
    const source = sanitizeApiSource(
      [
        "/*",
        'app.use("/api/*", async (c, next) => {',
        '  if (!session) return c.json({ error: "unauthorized" }, 401);',
        "});",
        'app.get("/api/commented-out", handler);',
        "*/",
        'app.get("/api/real", handler);',
      ].join("\n"),
    );

    expect(sessionGuardLine(source.split("\n"))).toBe(-1);
    expect(apiRegistrations(source).map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "get", path: "/api/real" },
    ]);
  });
});
