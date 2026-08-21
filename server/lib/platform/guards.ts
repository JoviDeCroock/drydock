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
