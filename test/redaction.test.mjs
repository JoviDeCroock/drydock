import { describe, expect, test } from "vitest";
import { redactText } from "../server/lib/review";
import { FINDING_SECRET_PATTERNS } from "../server/lib/review/rules/patterns";

describe("secret redaction", () => {
  test("redacts npm and github tokens", () => {
    const out = redactText(
      "use npm_aaaaaaaaaaaaaaaaaaaaaaaa and ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    expect(out).toContain("[REDACTED_NPM_TOKEN]");
    expect(out).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(out).not.toMatch(/npm_a{10,}/);
    expect(out).not.toMatch(/ghp_b{10,}/);
  });

  test("redacts aws, google, stripe, and slack tokens", () => {
    const out = redactText(
      [
        "AKIAABCDEFGHIJKLMNOP",
        "AIza1234567890abcdefghijklmnopqrstuvwxy",
        "sk_live_aaaaaaaaaaaaaaaaaaaaaaaa",
        "xoxb-12345-abcdefghij",
        "https://hooks.slack.com/services/T0/B0/abcdef",
      ].join("\n"),
    );
    expect(out).toContain("[REDACTED_AWS_ACCESS_KEY]");
    expect(out).toContain("[REDACTED_GOOGLE_API_KEY]");
    expect(out).toContain("[REDACTED_STRIPE_KEY]");
    expect(out).toContain("[REDACTED_SLACK_TOKEN]");
    expect(out).toContain("[REDACTED_SLACK_WEBHOOK]");
  });

  test("redacts standalone JWT tokens and URLs with embedded credentials", () => {
    const bareJwt = redactText("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturepart12345");
    expect(bareJwt).toBe("[REDACTED_JWT]");
    const urlOut = redactText("connect via https://user:pass@example.com/path?ok=1");
    expect(urlOut).toContain("[REDACTED_URL_WITH_CREDENTIALS]");
  });

  test("redacts authorization bearer headers", () => {
    const out = redactText('Authorization: "Bearer abcdef0123456789abcdef0123456789"');
    expect(out).toContain("[REDACTED_BEARER]");
  });

  test("redacts generic secret values with punctuation", () => {
    const out = redactText("password: 'abc!def@ghi#jkl'");
    expect(out).toContain("password: [REDACTED_SECRET]");
    expect(out).not.toContain("abc!def@ghi#jkl");
  });

  test("does not redact token getter calls as generic secrets", () => {
    const source = 'const token = localStorage.getItem("token");';
    expect(redactText(source)).toBe(source);
  });

  test("redacts private key blocks, each block on its own", () => {
    const body = `${"MIIEvQIBADANBgkqhkiG9w0BAQEFAASC".repeat(2)}\n`.repeat(20);
    const pem = `-----BEGIN PRIVATE KEY-----\n${body}-----END PRIVATE KEY-----`;
    const encrypted = `-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0A1B\n\n${body}-----END RSA PRIVATE KEY-----`;
    const escaped = pem.replaceAll("\n", "\\n");
    const out = redactText(`a ${pem}\nb ${encrypted}\nc "${escaped}"`);
    expect(out).toBe(
      'a [REDACTED_PRIVATE_KEY]\nb [REDACTED_PRIVATE_KEY]\nc "[REDACTED_PRIVATE_KEY]"',
    );
  });

  // A JWT header always opens with `eyJ` (base64 of `{"`), so whatever shares
  // its base64url run before that is an encoding or naming prefix, kept as is.
  test.each([
    ["an escape sequence", '"line\\n', '"line\\n'],
    ["a query separator", "?session=", "?session="],
    ["a URL-encoded separator", "?token%3D", "?token%3D"],
    ["an express-session cookie prefix", "connect.sid=s%3A", "connect.sid=s%3A"],
    ["an escaped quote", '\\"', '\\"'],
    ["a hex-escaped quote", "\\x22", "\\x22"],
    ["a unicode-escaped quote", "\\u0022", "\\u0022"],
    ["an underscore name", "jwt_", "jwt_"],
    ["a longer base64url run", "AAAA", "AAAA"],
  ])("redacts a JWT after %s, keeping the prefix", (_name, before, kept) => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturepart12345";
    expect(redactText(`${before}${jwt}&x=1`)).toBe(`${kept}[REDACTED_JWT]&x=1`);
    expect(
      FINDING_SECRET_PATTERNS.some(([pattern]) => {
        pattern.lastIndex = 0;
        return pattern.test(`${before}${jwt}`);
      }),
    ).toBe(true);
  });

  test("a dangling private key header does not unprotect the body before the next header", () => {
    const body = `${"MIIEvQIBADANBgkqhkiG9w0BAQEFAASC".repeat(2)}\n`.repeat(3);
    const complete = `-----BEGIN PRIVATE KEY-----\n${body}-----END PRIVATE KEY-----`;
    const out = redactText(`-----BEGIN PRIVATE KEY-----\n${body}${complete}\nafter`);
    expect(out).not.toContain("MIIEvQ");
    expect(out).toMatch(/\[REDACTED_PRIVATE_KEY\]\nafter$/);
    expect(redactText(`-----BEGIN PRIVATE KEY-----\nabc\n${complete}`)).not.toContain("MIIEvQ");
  });

  test("a private key header with no END and no later header is left alone", () => {
    const text = "-----BEGIN PRIVATE KEY-----\n<your key here>\n";
    expect(redactText(text)).toBe(text);
  });

  test("an unquoted secret running into a call ends at its last separator", () => {
    expect(redactText("API_TOKEN=abcdef123456789xyz\n")).toBe("API_TOKEN=[REDACTED_SECRET]\n");
    expect(redactText("password=abcdef123456,next()")).toBe("password=[REDACTED_SECRET],next()");
    expect(redactText("token=abcdef123456=next()")).toBe("token=[REDACTED_SECRET]=next()");
  });

  // Each input repeats the opening of a secret pattern without ever completing
  // it, which made the old patterns rescan the rest of the text from every
  // repetition (quadratic). About 1 MiB each; the linear patterns finish in
  // tens of milliseconds, the old ones took minutes.
  test.each([
    ["private key headers", "-----BEGIN PRIVATE KEY-----\n", ""],
    ["private key headers with bodies", `-----BEGIN PRIVATE KEY-----\n${"A".repeat(64)}\n`, ""],
    [
      "private key headers with dashed lines",
      `-----BEGIN PRIVATE KEY-----\n${"-a".repeat(70)}`,
      "",
    ],
    ["JWT prefixes", "eyJ", ""],
    ["JWT prefixes with one segment", "eyJaaaaaaaaaaaa.", ""],
    ["URL-encoded JWT prefixes", "%3DeyJaaaaaaaaaaaa", ""],
    ["underscore JWT prefixes", "_eyJaaaaaaaaaaaa", ""],
    ["prefixed JWT prefixes", "a.b.c-eyJ", ""],
    ["dangling private key headers", "-----BEGIN PRIVATE KEY-----\nMIIEvQ\n", "-----END"],
    ["secret assignments", "token=", "("],
  ])("redaction and secret findings stay linear on repeated %s", (_name, unit, tail) => {
    const text = unit.repeat(Math.ceil((1024 * 1024) / unit.length)) + tail;
    const started = performance.now();
    redactText(text);
    for (const [pattern] of FINDING_SECRET_PATTERNS) {
      text.replace(new RegExp(pattern.source, pattern.flags), "");
    }
    expect(performance.now() - started).toBeLessThan(2000);
  });

  // The per-file cap admits one 25 MiB base64url run; a `{10,}` loop that has
  // to backtrack across it overflowed the regex stack instead of failing.
  test("a JWT prefix in a 25 MiB base64url run fails without a stack overflow", () => {
    const text = "eyJ".repeat(Math.ceil((25 * 1024 * 1024) / 3));
    const jwtPatterns = FINDING_SECRET_PATTERNS.filter(([, label]) => label.includes("JWT"));
    expect(jwtPatterns).toHaveLength(1);
    for (const [pattern] of jwtPatterns) {
      expect(text.replace(new RegExp(pattern.source, pattern.flags), "$1[REDACTED_JWT]")).toBe(
        text,
      );
    }
  }, 30_000);
});
