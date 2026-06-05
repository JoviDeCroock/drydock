import { describe, expect, test } from "vitest";
import { nativeScryptPassword, scryptKeyHex } from "../../server/lib/auth";

// Golden vectors produced by Better Auth's @noble/hashes scrypt
// (N=16384, r=16, p=1, dkLen=64) — the implementation the Workers runtime would
// otherwise fall back to. auth.ts swaps in node:crypto's native scrypt for speed;
// these lock the migration-safety invariant that the native KDF produces
// byte-identical output, so password hashes written before the swap (or by any
// runtime still on @noble) keep verifying. If this fails, the swap is NOT a
// transparent drop-in and would lock existing users out. See better-auth#8456.
const NOBLE_VECTORS = [
  {
    password: "correct horse battery staple",
    salt: "00112233445566778899aabbccddeeff",
    key: "f5b22309b28fe412c82a4b2cab57498b8f8a42c849af16cb908974048f61c13933421858db3a8f111430bdc493c7cef90f61f904061c77206e3820a2e8b11bc2",
  },
  {
    // Non-ASCII to pin NFKC normalization behavior across implementations.
    password: "córrect-horse é password",
    salt: "deadbeefdeadbeefdeadbeefdeadbeef",
    key: "7e3afce44a95375a525c1f543efe272c4ae032a6610018c49def22a929eb2e328c76851090a08279e02c27aa97e08afa4f2f4d8f78a883f9d2b431ef461f8c72",
  },
];

describe("native scrypt password hashing", () => {
  test("derives the same key as @noble/hashes scrypt for fixed inputs", async () => {
    for (const v of NOBLE_VECTORS) {
      expect(await scryptKeyHex(v.password, v.salt)).toBe(v.key);
    }
  });

  test("verifies hashes in the Better Auth `salt:hex` format written by @noble", async () => {
    for (const v of NOBLE_VECTORS) {
      const stored = `${v.salt}:${v.key}`;
      expect(await nativeScryptPassword.verify({ hash: stored, password: v.password })).toBe(true);
      expect(await nativeScryptPassword.verify({ hash: stored, password: `${v.password}!` })).toBe(
        false,
      );
    }
  });

  test("hash() output round-trips through verify() and uses a random salt", async () => {
    const a = await nativeScryptPassword.hash("a-sufficiently-long-password");
    const b = await nativeScryptPassword.hash("a-sufficiently-long-password");
    expect(a).not.toBe(b); // distinct random salts
    expect(
      await nativeScryptPassword.verify({ hash: a, password: "a-sufficiently-long-password" }),
    ).toBe(true);
    expect(
      await nativeScryptPassword.verify({ hash: a, password: "wrong-password-entirely" }),
    ).toBe(false);
  });

  test("verify() rejects malformed hashes instead of throwing", async () => {
    expect(await nativeScryptPassword.verify({ hash: "", password: "x" })).toBe(false);
    expect(await nativeScryptPassword.verify({ hash: "no-colon", password: "x" })).toBe(false);
  });
});
