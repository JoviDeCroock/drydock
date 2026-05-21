import { describe, expect, test } from "vitest";
import { redactText } from "../server/lib/review.ts";

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
});
