import { createHmac } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { sendWebhookNotification, validateWebhookUrl } from "../server/lib/notify/webhook";
import {
  encryptWebhookCredentials,
  decryptWebhookCredentials,
} from "../server/lib/notify/webhook-credentials";
import { decryptSlackBotToken, encryptSlackBotToken } from "../server/lib/platform/secret-box";

afterEach(() => vi.restoreAllMocks());

const event = {
  version: 1,
  id: "event-123",
  type: "notification.test",
  createdAt: "2026-09-13T12:00:00.000Z",
  organizationId: "org-123",
  data: { message: "Notification test" },
};
const input = {
  url: "https://hooks.example.com/secret-path?key=secret",
  secret: "signing-secret",
  event,
};

describe("webhook endpoint policy", () => {
  test.each([
    "http://hooks.example.com/",
    "https://user:password@hooks.example.com/",
    "https://hooks.example.com/#fragment",
    "https://hooks.example.com/#",
    "https://hooks.example.com:8443/",
    "https://localhost/",
    "https://internal/",
    "https://127.0.0.1/",
    "https://2130706433/",
    "https://0x7f000001/",
    "https://10.0.0.1/",
    "https://169.254.169.254/",
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://hooks.local/",
    "https://hooks.internal/",
    "https://hooks.localhost/",
    "https://hooks.test/",
    "https://hooks.home/",
    "https://hooks.lan/",
    "https://hooks.onion/",
    "https://hooks.arpa/",
    "invalid",
  ])("rejects %s before any request", async (url) => {
    const fetch = vi.spyOn(globalThis, "fetch");
    expect(validateWebhookUrl(url)).toBeNull();
    await expect(sendWebhookNotification({ ...input, url })).rejects.toThrow(
      "Webhook endpoint is invalid",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  test("accepts public HTTPS hostnames and preserves secret paths and queries", () => {
    expect(validateWebhookUrl(input.url)?.toString()).toBe(input.url);
    expect(validateWebhookUrl("https://hooks.example.com:443/receive")?.port).toBe("");
  });
});

describe("webhook delivery", () => {
  test("signs exact transmitted bytes and timestamp, bounds the request, and cancels without reading", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1789300800123);
    const cancel = vi.fn().mockResolvedValue(undefined);
    const text = vi.fn();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, body: { cancel }, text });
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await sendWebhookNotification(input);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe(input.url);
    expect(options.method).toBe("POST");
    expect(options.redirect).toBe("error");
    expect(timeout).toHaveBeenCalledWith(5000);
    expect(JSON.parse(options.body)).toEqual(event);
    const timestamp = "1789300800";
    expect(options.headers).toEqual({
      "Content-Type": "application/json",
      "X-Drydock-Timestamp": timestamp,
      "X-Drydock-Signature": `v1=${createHmac("sha256", input.secret).update(`${timestamp}.${options.body}`).digest("hex")}`,
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(text).not.toHaveBeenCalled();
  });

  test.each([302, 400, 500])("rejects status %s without reading content", async (status) => {
    const response = new Response("endpoint secret", { status });
    const text = vi.spyOn(response, "text");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    await expect(sendWebhookNotification(input)).rejects.toThrow(
      "Webhook endpoint returned an unsuccessful response",
    );
    expect(text).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  test("sanitizes network and timeout failures", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error(`failed for ${input.url}`));
    await expect(sendWebhookNotification(input)).rejects.toThrow(/^Webhook delivery failed$/);
  });
});

describe("webhook credential encryption", () => {
  const env = { NPM_CONNECTIONS_ENCRYPTION_KEY: "encryption-key-with-at-least-32-characters" };
  const credentials = { url: input.url, secret: input.secret };

  test("encrypts the endpoint and signing secret with fresh nonces", async () => {
    const first = await encryptWebhookCredentials(env, credentials);
    const second = await encryptWebhookCredentials(env, credentials);
    expect(first).not.toEqual(second);
    expect(first.ciphertext).not.toContain(input.secret);
    expect(first.ciphertext).not.toContain(input.url);
    expect(await decryptWebhookCredentials(env, first)).toEqual(credentials);
  });

  test("rejects modified ciphertext and mismatched keys", async () => {
    const encrypted = await encryptWebhookCredentials(env, credentials);
    await expect(
      decryptWebhookCredentials(env, { ...encrypted, ciphertext: `${encrypted.ciphertext}AAAA` }),
    ).rejects.toThrow();
    await expect(
      decryptWebhookCredentials(
        { NPM_CONNECTIONS_ENCRYPTION_KEY: "other-encryption-key-at-least-32-characters" },
        encrypted,
      ),
    ).rejects.toThrow();
  });

  test("separates webhook and Slack credential encryption domains", async () => {
    const webhook = await encryptWebhookCredentials(env, credentials);
    await expect(decryptSlackBotToken(env, webhook)).rejects.toThrow();
    const slack = await encryptSlackBotToken(env, "xoxb-slack-token");
    await expect(decryptWebhookCredentials(env, slack)).rejects.toThrow();
  });

  test("rejects missing key material and unknown ciphertext versions", async () => {
    await expect(encryptWebhookCredentials({}, credentials)).rejects.toThrow(
      "NPM_CONNECTIONS_ENCRYPTION_KEY is required",
    );
    await expect(
      decryptWebhookCredentials(env, { ciphertext: "v2:example", nonce: "nonce" }),
    ).rejects.toThrow("Webhook credential version is unsupported");
  });
});
