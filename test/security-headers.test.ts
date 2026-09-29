import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  API_CSP,
  createScriptNonce,
  DOCUMENT_CSP,
  documentCspWithScriptNonce,
  SECURITY_HEADERS,
} from "../server/lib/platform/security-headers";

// public/_headers can't import the shared module, so this guard asserts its
// hand-copied values still match the source of truth. The ASSETS binding
// attaches them to every asset before the Worker's middleware replaces them.
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

function parseCsp(policy: string): Map<string, string> {
  const directives = new Map<string, string>();
  for (const directive of policy.split(";")) {
    const [name, ...value] = directive.trim().split(/\s+/);
    if (name) directives.set(name, value.join(" "));
  }
  return directives;
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

  test("document CSP rejects inline CSS", () => {
    expect(DOCUMENT_CSP).toContain("style-src 'self'");
    expect(DOCUMENT_CSP).toContain("style-src-attr 'none'");
    expect(DOCUMENT_CSP).not.toContain("'unsafe-inline'");
  });

  // Geist is self-hosted; the policy must never reach back out to a font CDN
  // (no third-party origin in style-src/font-src means no visitor-IP leak).
  test("document CSP loads fonts only from same origin", () => {
    expect(DOCUMENT_CSP).toContain("font-src 'self'");
    expect(DOCUMENT_CSP).not.toContain("fonts.googleapis.com");
    expect(DOCUMENT_CSP).not.toContain("fonts.gstatic.com");
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

  test("ships a deny-all CSP fallback with explicit document directives", () => {
    const directives = parseCsp(DOCUMENT_CSP);
    expect(directives.get("default-src")).toBe("'none'");
    expect(directives.get("base-uri")).toBe("'self'");
    expect(directives.get("object-src")).toBe("'none'");
    expect(directives.get("frame-ancestors")).toBe("'none'");
    expect(directives.get("form-action")).toBe("'self'");
    expect(directives.get("script-src")).toBe("'self'");
    expect(directives.get("style-src")).toContain("'self'");
    expect(directives.get("font-src")).toBe("'self'");
    expect(directives.get("img-src")).toContain("data:");
    expect(directives.get("connect-src")).toBe("'self'");
    expect(directives.get("frame-src")).toBe("'none'");
    expect(directives.get("child-src")).toBe("'none'");
    expect(directives.get("worker-src")).toBe("'none'");
    expect(directives.get("manifest-src")).toBe("'self'");
    expect(directives.get("media-src")).toBe("'self'");
  });
});

describe("document CSP script nonce", () => {
  test("adds the nonce to the script directives and changes nothing else", () => {
    const base = parseCsp(DOCUMENT_CSP);
    const nonced = parseCsp(documentCspWithScriptNonce("abc123=="));
    expect(nonced.get("script-src")).toBe("'self' 'nonce-abc123=='");
    expect(nonced.get("script-src-elem")).toBe("'self' 'nonce-abc123=='");
    expect(nonced.get("script-src-attr")).toBe("'none'");
    for (const [name, value] of base) {
      if (name !== "script-src" && name !== "script-src-elem") expect(nonced.get(name)).toBe(value);
    }
    expect(nonced.size).toBe(base.size);
    expect(documentCspWithScriptNonce("abc123==")).not.toContain("'unsafe-inline'");
  });

  test("draws a fresh 128-bit nonce each time", () => {
    const nonces = new Set(Array.from({ length: 50 }, () => createScriptNonce()));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});
