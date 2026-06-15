import { describe, expect, test } from "vitest";

const { buildAccountVerificationEmail } = await import("../server/lib/account-email.ts");

describe("buildAccountVerificationEmail", () => {
  const url = "https://drydock.org/api/auth/verify-email?token=abc123&callbackURL=%2Fverify-email";

  test("composes a verification subject and embeds the link in both parts", () => {
    const content = buildAccountVerificationEmail(url);
    expect(content.subject).toMatch(/verify/i);
    expect(content.text).toContain(url);
    // The href is attribute-escaped, so assert on the escaped form.
    expect(content.html).toContain(
      'href="https://drydock.org/api/auth/verify-email?token=abc123&amp;callbackURL=%2Fverify-email"',
    );
    expect(content.text).toMatch(/24 hours/);
    expect(content.html).toMatch(/24 hours/);
  });

  test("escapes HTML metacharacters so a crafted link can't break out of the href", () => {
    const hostile = 'https://evil.test/"></a><script>alert(1)</script>?x=1&y=2';
    const content = buildAccountVerificationEmail(hostile);
    expect(content.html).not.toContain("<script>");
    expect(content.html).not.toContain('"></a>');
    expect(content.html).toContain("&quot;&gt;&lt;/a&gt;&lt;script&gt;");
    expect(content.html).toContain("&amp;y=2");
    // The plain-text part carries the raw URL untouched (no markup to escape there).
    expect(content.text).toContain(hostile);
  });
});
