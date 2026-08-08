/**
 * Validation for bytes and identifiers arriving on the push-based CI ingest
 * path. Everything here treats its input as attacker-controlled: an OIDC token
 * proves which repository is calling, not that the repository is well-behaved.
 */

/** Artifact filenames are stored as bundle-relative paths, so keep them flat. */
const MAX_ARTIFACT_PATH_LENGTH = 200;
const SAFE_ARTIFACT_PATH = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

const MAX_RELEASE_KEY_LENGTH = 64;
const SAFE_RELEASE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * Reduce an uploaded artifact name to a safe flat filename, or reject it.
 *
 * Path separators, `..`, leading dots, and control characters are all refused
 * rather than sanitized: the name reaches an R2 key, a D1 unique index, and the
 * maintainer's report, and silently rewriting it would make those three
 * disagree about what was uploaded.
 */
export function normalizeArtifactPath(value: string): string | null {
  const decoded = safeDecode(value);
  if (decoded === null) return null;
  const trimmed = decoded.trim();
  if (!trimmed || trimmed.length > MAX_ARTIFACT_PATH_LENGTH) return null;
  if (trimmed.includes("/") || trimmed.includes("\\")) return null;
  if (trimmed === "." || trimmed === "..") return null;
  if (!SAFE_ARTIFACT_PATH.test(trimmed)) return null;
  return trimmed;
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * A run that publishes several independent releases separates them with a
 * release key. Empty is the normal case and means "the one release this run
 * produces".
 */
export function normalizeReleaseKey(value: unknown): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length > MAX_RELEASE_KEY_LENGTH) return null;
  return SAFE_RELEASE_KEY.test(trimmed) ? trimmed : null;
}

export function normalizeSha256(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const lowered = value.trim().toLowerCase();
  return SHA256_HEX.test(lowered) ? lowered : null;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface BoundedBodyResult {
  bytes: Uint8Array;
  tooLarge: boolean;
  received: number;
}

/**
 * Read a request body up to `maxBytes`, refusing anything larger.
 *
 * The declared `content-length` is checked first as a cheap reject, but the
 * running total is what actually enforces the cap — a client is free to lie in
 * the header, and a chunked upload has no header at all.
 */
export async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<BoundedBodyResult> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { bytes: new Uint8Array(), tooLarge: true, received: declared };
  }
  if (!request.body) return { bytes: new Uint8Array(), tooLarge: false, received: 0 };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { bytes: new Uint8Array(), tooLarge: true, received: total };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, tooLarge: false, received: total };
}
