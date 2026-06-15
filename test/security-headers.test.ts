import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { API_CSP, DOCUMENT_CSP, SECURITY_HEADERS } from "../server/lib/security-headers.ts";

// The HTML document the browser (and external scanners like Aikido) load is a
// static asset served by Cloudflare's edge, bypassing the Worker. Its security
// headers come from public/_headers, which can't import the shared module — so
// this guard asserts the hand-copied values still match the source of truth.
const headersFile = readFileSync(
  fileURLToPath(new URL("../public/_headers", import.meta.url)),
  "utf8",
);

// Minimal parser for the Cloudflare _headers format: an unindented path pattern
// followed by indented `Name: value` lines, `#` comments ignored.
function parseHeaders(source: string): Map<string, Record<string, string>> {
  const rules = new Map<string, Record<string, string>>();
  let current: Record<string, string> | null = null;
  for (const raw of source.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      current = {};
      rules.set(line.trim(), current);
      continue;
    }
    const idx = line.indexOf(":");
    if (current && idx !== -1) {
      current[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return rules;
}

describe("public/_headers static-asset security headers", () => {
  const rules = parseHeaders(headersFile);
  const catchAll = rules.get("/*");

  test("applies a policy to every static path", () => {
    expect(catchAll).toBeDefined();
  });

  test("CSP matches the shared document policy", () => {
    expect(catchAll?.["Content-Security-Policy"]).toBe(DOCUMENT_CSP);
  });

  test("allows PostHog EU product analytics ingestion", () => {
    expect(DOCUMENT_CSP).toContain("connect-src 'self' https://eu.i.posthog.com");
  });

  test("carries the same non-CSP security headers as the Worker", () => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(catchAll?.[name]).toBe(value);
    }
  });

  // The static document must never receive the API's deny-all CSP: that would
  // block its own scripts, styles and webfont and white-screen the app.
  test("does not ship the locked-down API CSP to the document", () => {
    expect(catchAll?.["Content-Security-Policy"]).not.toBe(API_CSP);
  });
});
