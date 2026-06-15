import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const { buildMimeMessage, sanitizeAddress, sendNotificationEmail } =
  await import("../server/lib/email.ts");

describe("sanitizeAddress", () => {
  test("accepts a plain email address", () => {
    expect(sanitizeAddress("user@example.com")).toBe("user@example.com");
  });

  test("trims whitespace and rejects header-injection attempts", () => {
    expect(sanitizeAddress("  user@example.com  ")).toBe("user@example.com");
    expect(sanitizeAddress("user@example.com\r\nBcc: leak@example.com")).toBeNull();
    expect(sanitizeAddress("<user@example.com>")).toBeNull();
  });

  test("rejects malformed input", () => {
    expect(sanitizeAddress("not-an-email")).toBeNull();
    expect(sanitizeAddress("")).toBeNull();
    expect(sanitizeAddress(42)).toBeNull();
    expect(sanitizeAddress(undefined)).toBeNull();
  });
});

describe("buildMimeMessage", () => {
  test("builds a plain-text MIME body with required headers", () => {
    const raw = buildMimeMessage({
      fromAddress: "drydock@drydock.org",
      fromName: "Drydock",
      to: "user@example.com",
      subject: "Scan complete",
      text: "Hello world",
    });

    expect(raw).toMatch(/^From: "Drydock" <drydock@drydock\.org>\r\n/);
    expect(raw).toContain("To: user@example.com\r\n");
    expect(raw).toContain("Subject: Scan complete\r\n");
    expect(raw).toContain('Content-Type: text/plain; charset="utf-8"');
    expect(raw).toContain("Content-Transfer-Encoding: 8bit");
    expect(raw).toContain("Hello world");
  });

  test("encodes non-ascii subjects using MIME word encoding", () => {
    const raw = buildMimeMessage({
      fromAddress: "drydock@drydock.org",
      fromName: "Drydock",
      to: "user@example.com",
      subject: "Scan — done ✓",
      text: "ok",
    });
    expect(raw).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
  });

  test("emits multipart/alternative when html is provided", () => {
    const raw = buildMimeMessage({
      fromAddress: "drydock@drydock.org",
      fromName: "Drydock",
      to: "user@example.com",
      subject: "Scan",
      text: "plain body",
      html: "<p>html body</p>",
    });
    expect(raw).toMatch(/Content-Type: multipart\/alternative; boundary="=_drydock_/);
    expect(raw).toContain("plain body");
    expect(raw).toContain("<p>html body</p>");
  });
});

describe("sendNotificationEmail", () => {
  test("reports a missing binding without throwing", async () => {
    const result = await sendNotificationEmail(
      {},
      {
        to: "user@example.com",
        subject: "Subject",
        text: "Body",
      },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/SEND_EMAIL/);
  });

  test("rejects malformed recipients before reaching the binding", async () => {
    const env = { SEND_EMAIL: { send: vi.fn() } };
    const result = await sendNotificationEmail(env, {
      to: "not-an-email",
      subject: "Subject",
      text: "Body",
    });
    expect(result.ok).toBe(false);
    expect(env.SEND_EMAIL.send).not.toHaveBeenCalled();
  });
});
