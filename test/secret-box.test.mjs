import { describe, expect, test } from "vitest";
import { base64UrlEncode } from "../server/lib/platform/crypto-utils";
import {
  decryptSlackBotToken,
  encryptSlackBotToken,
  openSecret,
  sealSecret,
} from "../server/lib/platform/secret-box";

const KEY = "0123456789abcdef0123456789abcdef";
const env = { NPM_CONNECTIONS_ENCRYPTION_KEY: KEY };
const BOT_TOKEN = "xoxb-0000000000-1111111111-AbCdEfGhIjKlMnOpQrStUvWx";

describe("encryptSlackBotToken / decryptSlackBotToken", () => {
  test("round-trips a bot token through encryption", async () => {
    const encrypted = await encryptSlackBotToken(env, BOT_TOKEN);
    expect(encrypted.ciphertext.startsWith("v1:")).toBe(true);
    expect(encrypted.ciphertext).not.toContain("xoxb-");
    expect(encrypted.ciphertext).not.toContain("AbCdEfGhIjKlMnOpQrStUvWx");

    const plaintext = await decryptSlackBotToken(env, encrypted);
    expect(plaintext).toBe(BOT_TOKEN);
  });

  test("trims surrounding whitespace before encrypting", async () => {
    const encrypted = await encryptSlackBotToken(env, `  ${BOT_TOKEN}\n`);
    const plaintext = await decryptSlackBotToken(env, encrypted);
    expect(plaintext).toBe(BOT_TOKEN);
  });

  test("uses a fresh nonce per call so ciphertext is non-deterministic", async () => {
    const a = await encryptSlackBotToken(env, BOT_TOKEN);
    const b = await encryptSlackBotToken(env, BOT_TOKEN);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  test("rejects an empty secret", async () => {
    await expect(encryptSlackBotToken(env, "   ")).rejects.toThrow();
  });

  test("decryption fails under a different key", async () => {
    const encrypted = await encryptSlackBotToken(env, BOT_TOKEN);
    const otherEnv = { NPM_CONNECTIONS_ENCRYPTION_KEY: "ffffffffffffffffffffffffffffffff" };
    await expect(decryptSlackBotToken(otherEnv, encrypted)).rejects.toThrow();
  });

  test("requires a key of at least 32 characters", async () => {
    await expect(
      encryptSlackBotToken({ NPM_CONNECTIONS_ENCRYPTION_KEY: "short" }, BOT_TOKEN),
    ).rejects.toThrow("at least 32 characters");
    await expect(
      encryptSlackBotToken({ NPM_CONNECTIONS_ENCRYPTION_KEY: "" }, BOT_TOKEN),
    ).rejects.toThrow("required");
  });

  test("still decrypts a token sealed under the original Slack-only derivation", async () => {
    const material = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(KEY),
      "HKDF",
      false,
      ["deriveKey"],
    );
    const legacyKey = await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new TextEncoder().encode("drydock:slack-bot-token:salt:v1"),
        info: new TextEncoder().encode("aes-gcm-256"),
      },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      legacyKey,
      new TextEncoder().encode(BOT_TOKEN),
    );
    const plaintext = await decryptSlackBotToken(env, {
      ciphertext: `v1:${base64UrlEncode(new Uint8Array(sealed))}`,
      nonce: base64UrlEncode(nonce),
    });
    expect(plaintext).toBe(BOT_TOKEN);
  });
});

describe("sealSecret / openSecret", () => {
  test("a secret sealed for one purpose cannot be opened as another", async () => {
    const sealed = await sealSecret(env, "pypi-project-token", "pypi-AgEIcHlwaS5vcmc");
    expect(await openSecret(env, "pypi-project-token", sealed)).toBe("pypi-AgEIcHlwaS5vcmc");
    await expect(openSecret(env, "pypi-session-links", sealed)).rejects.toThrow();
    await expect(openSecret(env, "slack-bot-token", sealed)).rejects.toThrow();
  });
});
