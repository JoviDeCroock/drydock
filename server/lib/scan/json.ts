/**
 * Parse text that should hold a JSON object. Anything else — invalid JSON,
 * a scalar, an array — is `null`, so callers can branch without a try/catch.
 */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
