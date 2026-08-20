/**
 * RFC 4122 name-based (version 5) UUIDs.
 *
 * Exists because another system's identifiers have to be reproduced exactly.
 * atpm names a staged release by `uuidv5(<record uri>/<record cid>)` in the URL
 * namespace, and that string is what a maintainer passes to `npm stage approve`.
 * Deriving the same value here means Drydock can show the id that approves the
 * release it just reviewed, without asking atpm.dev for it.
 */

/** The RFC 4122 URL namespace, which is the one atpm hashes under. */
export const UUID_NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidToBytes(uuid: string): Uint8Array {
  if (!UUID_RE.test(uuid)) throw new Error("invalid UUID");
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/**
 * `uuidv5(name, namespace)`: SHA-1 over the namespace bytes followed by the
 * name, truncated to 16 bytes with the version and variant fields overwritten.
 *
 * SHA-1 is what the specification mandates for version 5 and is not a security
 * property here — the value is an identifier for a record that is already
 * addressed by its own content hash.
 */
export async function uuidV5(name: string, namespace: string): Promise<string> {
  const namespaceBytes = uuidToBytes(namespace);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(namespaceBytes.length + nameBytes.length);
  input.set(namespaceBytes, 0);
  input.set(nameBytes, namespaceBytes.length);

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  const bytes = digest.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant

  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
