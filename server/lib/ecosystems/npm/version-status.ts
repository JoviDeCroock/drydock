import { normalizeRegistryUrl, type NormalizeRegistryUrlOptions } from "./connection";
import { reliableFetch } from "../../platform/reliable-fetch";

/**
 * npm's own lifecycle status for an exact package version, from
 * `GET /-/package/{name}/version/{version}/status`.
 *
 * This is the *registry's* view, not Drydock's. npm deliberately reports
 * progress "without exposing validation-system details", so there is no
 * per-check detail behind these values — `blocked` says npm's automated
 * validation rejected the version, not why.
 */
const NPM_VERSION_STATUSES = ["published", "validating", "staged", "blocked", "deleted"] as const;

export type NpmVersionStatus = (typeof NPM_VERSION_STATUSES)[number];

/**
 * Statuses that can still change. `staged` and `validating` are still moving
 * toward a release outcome, while `published` can become `deleted` if the live
 * version is later removed. Only `blocked` and `deleted` are terminal.
 */
const NON_TERMINAL_STATUSES = new Set<string>(["staged", "validating", "published"]);

function isNpmVersionStatus(value: unknown): value is NpmVersionStatus {
  return typeof value === "string" && (NPM_VERSION_STATUSES as readonly string[]).includes(value);
}

export function isTerminalNpmVersionStatus(value: unknown): boolean {
  return isNpmVersionStatus(value) && !NON_TERMINAL_STATUSES.has(value);
}

/**
 * Why a lookup produced no status. Every one of these means "we do not know",
 * never "nothing is wrong" and never "something is wrong" — see
 * `NpmVersionStatusLookup`.
 */
type NpmVersionStatusUnavailableReason =
  /** 404. npm returns this both for an unknown version and for an authorization failure, so it is irreducibly ambiguous. */
  | "not_found"
  /** 401/403. The token cannot ask about this package. */
  | "unauthorized"
  /** 400. We asked about a name/version npm would not parse. */
  | "rejected"
  /** 429. Backed off by the registry. */
  | "rate_limited"
  /** Transport failure, 5xx, or an unparseable/unrecognized body. */
  | "unavailable"
  /** Asked without a package name or version to ask about. */
  | "incomplete_input";

export type NpmVersionStatusLookup =
  | { ok: true; status: NpmVersionStatus }
  | { ok: false; reason: NpmVersionStatusUnavailableReason; httpStatus: number | null };

// npm documents 429 on this endpoint and the whole feature is advisory, so a
// single attempt is right: `reliableFetch` would turn one throttled lookup into
// three. Everything a lookup tells us is re-derivable on the next sweep.
const LOOKUP_TIMEOUT_MS = 5_000;
const MAX_LOOKUP_RESPONSE_BYTES = 16 * 1024;

export interface NpmVersionStatusLookupOptions extends NormalizeRegistryUrlOptions {
  timeoutMs?: number;
}

// Mirrors npm's own package-name grammar closely enough to keep anything that
// could alter the request path out of the URL. Rejecting here rather than
// escaping means a malformed name is never silently asked about under some
// other name.
const PACKAGE_NAME_RE = /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

/**
 * Ask npm where an exact package version stands.
 *
 * Never throws: every failure mode collapses into an `ok: false` lookup, because
 * every caller is decorating something that has to work without it. The 404
 * case is the reason this contract matters — npm returns "not found" for a
 * version that does not exist *and* for a package this token may not ask about,
 * so a failed lookup can never be rendered as a negative signal about the
 * release.
 */
export async function fetchNpmVersionStatus(
  registryUrl: string,
  token: string,
  packageName: string | null | undefined,
  version: string | null | undefined,
  options: NpmVersionStatusLookupOptions = {},
): Promise<NpmVersionStatusLookup> {
  if (!packageName || !version) return unavailable("incomplete_input");
  if (packageName.length > 214 || !PACKAGE_NAME_RE.test(packageName) || !VERSION_RE.test(version)) {
    return unavailable("rejected");
  }

  let url: string;
  try {
    const registry = normalizeRegistryUrl(registryUrl, options);
    // The spec requires scoped names URL-encoded "with the slash escaped", so
    // this is the one npm path where `@scope/name` must NOT be un-escaped back
    // to `@scope/name` the way the packument route does it.
    url = `${registry}/-/package/${encodeURIComponent(packageName)}/version/${encodeURIComponent(version)}/status`;
  } catch {
    return unavailable("rejected");
  }

  const timeoutMs = options.timeoutMs ?? LOOKUP_TIMEOUT_MS;
  const deadlineMs = Date.now() + timeoutMs;
  let response: Response;
  try {
    response = await reliableFetch(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "user-agent": "staged-publish-review/version-status",
      },
      timeoutMs,
      attempts: 1,
    });
  } catch {
    // Transport failure, timeout, or abort. Nothing about it distinguishes a
    // registry that is down from one that will not answer, and neither is a
    // statement about the release.
    return unavailable("unavailable");
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return unavailable(reasonForStatus(response.status), response.status);
  }

  const data = await readBoundedJson(response, deadlineMs);
  const status = readStatus(data, packageName, version);
  if (!status) return unavailable("unavailable", response.status);
  return { ok: true, status };
}

async function readBoundedJson(response: Response, deadlineMs: number): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const remainingMs = Math.max(0, deadlineMs - Date.now());
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), remainingMs);
  });

  try {
    while (true) {
      const read = await Promise.race([reader.read(), timeout]);
      if (read === null) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      if (read.done) break;
      byteLength += read.value.byteLength;
      if (byteLength > MAX_LOOKUP_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(read.value);
    }
  } catch {
    void reader.cancel().catch(() => undefined);
    return null;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    reader.releaseLock();
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return null;
  }
}

function readStatus(
  data: unknown,
  expectedPackageName: string,
  expectedVersion: string,
): NpmVersionStatus | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  // The registry response carries the exact coordinates because the status is
  // meaningful only for that release. Fail closed on a mismatched proxy/cache
  // response rather than persisting another version's verdict against this scan.
  if (record.packageName !== expectedPackageName || record.version !== expectedVersion) return null;
  const value = record.status;
  // An unrecognized value means npm grew a state we do not model. Treat it as
  // unknown rather than passing it through: everything downstream branches on
  // the enum, and a surprise string would render as an unexplained badge.
  return isNpmVersionStatus(value) ? value : null;
}

function reasonForStatus(httpStatus: number): NpmVersionStatusUnavailableReason {
  if (httpStatus === 404) return "not_found";
  if (httpStatus === 401 || httpStatus === 403) return "unauthorized";
  if (httpStatus === 400) return "rejected";
  if (httpStatus === 429) return "rate_limited";
  return "unavailable";
}

function unavailable(
  reason: NpmVersionStatusUnavailableReason,
  httpStatus: number | null = null,
): NpmVersionStatusLookup {
  return { ok: false, reason, httpStatus };
}
