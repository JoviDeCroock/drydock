import { describe, expect, test } from "vitest";

const { buildAccountVerificationEmail, buildPasswordResetEmail, buildPasswordChangedEmail } =
  await import("../server/lib/notify/account-email");

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

describe("buildPasswordResetEmail", () => {
  const url = "https://drydock.org/reset-password#token=abc123";

  test("embeds the link in both parts and states its lifetime and side effect", () => {
    const content = buildPasswordResetEmail(url, 60);
    expect(content.subject).toMatch(/password/i);
    expect(content.text).toContain(url);
    expect(content.html).toContain(`href="${url}"`);
    for (const part of [content.text, content.html]) {
      expect(part).toMatch(/60 minutes/);
      expect(part).toMatch(/works once/);
      expect(part).toMatch(/signs the account out on every device/);
    }
  });

  test("escapes HTML metacharacters so a crafted link can't break out of the href", () => {
    const hostile = 'https://evil.test/"></a><script>alert(1)</script>#token=1&y=2';
    const content = buildPasswordResetEmail(hostile, 60);
    expect(content.html).not.toContain("<script>");
    expect(content.html).not.toContain('"></a>');
    expect(content.html).toContain("&amp;y=2");
    expect(content.text).toContain(hostile);
  });
});

describe("buildPasswordChangedEmail", () => {
  test("tells the owner a password was set and carries no link", () => {
    const content = buildPasswordChangedEmail();
    expect(content.subject).toBe("Your Drydock password was set");
    expect(content.text).toContain("signed out");
    expect(`${content.text}${content.html}`).not.toMatch(/https?:\/\/|href=/);
  });
});
