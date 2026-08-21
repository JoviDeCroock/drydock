/**
 * Path safety for archive- and manifest-declared file paths.
 *
 * Package bytes are hostile evidence: a path that escapes its archive root, or
 * that carries a NUL/drive-letter/backslash a downstream consumer resolves
 * differently, must never reach persistence or the UI. Every ecosystem's
 * manifest parser shares this guard so a hardening fix lands once rather than
 * three times.
 */

const MAX_MANIFEST_PATH_LENGTH = 512;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;

export function isSafeManifestPath(path: string): boolean {
  if (!path || path.length > MAX_MANIFEST_PATH_LENGTH || path.includes("\0") || path.includes("\\"))
    return false;
  if (path.startsWith("/") || path.startsWith("../") || path.includes("/../")) return false;
  if (WINDOWS_DRIVE_RE.test(path)) return false;
  return path.split("/").every((part) => part && part !== "." && part !== "..");
}
