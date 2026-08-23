/**
 * Narrowing guards for values parsed from untrusted JSON.
 *
 * Registry metadata, ATProto records, VSIX manifests and persisted summary
 * blobs all arrive as `unknown`. These are the shared primitives every parser
 * narrows with, so the definition of "a plain object" cannot drift between
 * ecosystems.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether text contains C0/DEL characters that can corrupt logs or rendered evidence. */
export function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
