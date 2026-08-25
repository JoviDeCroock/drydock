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
const HEX_BYTE_RE = /^[0-9A-Fa-f]{2}$/;
const URL_PATH_ENCODER = new TextEncoder();
const URL_PATH_DECODER = new TextDecoder();

export function isSafeManifestPath(path: string): boolean {
  if (!path || path.length > MAX_MANIFEST_PATH_LENGTH || path.includes("\0") || path.includes("\\"))
    return false;
  if (path.startsWith("/") || path.startsWith("../") || path.includes("/../")) return false;
  if (WINDOWS_DRIVE_RE.test(path)) return false;
  return path.split("/").every((part) => part && part !== "." && part !== "..");
}

/** Decode a URL path before matching it against an archive entry. */
export function decodeUrlPathForArchiveLookup(path: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < path.length;) {
    const encodedByte = path.slice(index + 1, index + 3);
    if (path[index] === "%" && HEX_BYTE_RE.test(encodedByte)) {
      bytes.push(Number.parseInt(encodedByte, 16));
      index += 3;
      continue;
    }
    const codePoint = path.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    bytes.push(...URL_PATH_ENCODER.encode(character));
    index += character.length;
  }
  return URL_PATH_DECODER.decode(Uint8Array.from(bytes));
}
