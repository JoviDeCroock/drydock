import { base64Encode } from "./crypto-utils";

// Local-only escape hatch; never set this in deployed configuration.
export function securityHeadersDisabled(
  env: Pick<Cloudflare.Env, "DISABLE_SECURITY_HEADERS">,
): boolean {
  return env.DISABLE_SECURITY_HEADERS === "true";
}

// Keep these values aligned with public/_headers; the invariant test guards drift.
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

export const API_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

export const DOCUMENT_CSP = [
  "default-src 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "script-src-elem 'self'",
  "script-src-attr 'none'",
  "style-src 'self'",
  "style-src-elem 'self'",
  "style-src-attr 'none'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "manifest-src 'self'",
  "media-src 'self'",
].join("; ");

const NONCED_DIRECTIVES = new Set(["script-src", "script-src-elem"]);

/**
 * The document policy for one HTML response, with a script nonce for
 * Cloudflare's JavaScript detections. Bot Fight Mode injects an inline script
 * into every HTML page (the plan cannot turn it off) and stamps the nonce it
 * finds in the CSP response header onto that script and onto the one it
 * creates inside its hidden iframe, which inherits this policy. Cloudflare
 * reads only the header, not a `<meta>` tag. The app ships no inline script and
 * must not start relying on this nonce; `'self'` stays its only script source.
 */
export function documentCspWithScriptNonce(nonce: string): string {
  return DOCUMENT_CSP.split("; ")
    .map((directive) =>
      NONCED_DIRECTIVES.has(directive.split(" ", 1)[0])
        ? `${directive} 'nonce-${nonce}'`
        : directive,
    )
    .join("; ");
}

/** A fresh nonce per response; a reused one would admit any injected script that copies it. */
export function createScriptNonce(): string {
  return base64Encode(crypto.getRandomValues(new Uint8Array(16)));
}
