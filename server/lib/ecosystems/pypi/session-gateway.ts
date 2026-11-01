import { isRecord } from "../../platform/guards";
import { readBoundedJson } from "../../platform/bounded-body";
import { normalizePyPiProjectName } from "./manifest";
import { parseStrictHttpsUrl } from "./stage";
import { pyPiVersionsEquivalent } from "./version";

/**
 * The only code that attaches a stored PyPI API token to a request (PEP 694
 * mode B, preview). It is the PyPI analogue of the `NpmStageGateway` rule:
 *
 * - it runs in the parent Worker; the token never enters the sandbox, which
 *   is not involved in session control at all;
 * - it attaches the token only to an https URL on an allowlisted Upload 2.0
 *   root for the token's own index: POST to the root itself creates a
 *   session; every other request (session status/cancel/publish/extend, file
 *   upload, byte upload, completion, file status/delete) must sit strictly
 *   under the root, on the origin of the session Drydock created;
 * - every link it follows (`links.*`, `file-upload-session`, `complete`, the
 *   `http-post-bytes` `file_url`) comes from the index's own answers, never
 *   from the workflow, and passes the same policy before use;
 * - token-bearing requests never follow redirects: a 3xx is an error, so a
 *   `Location` cannot carry the token anywhere.
 *
 * Errors name the operation, never URLs or the token.
 */

// Upload 2.0 roots per index (origin + path prefix). PEP 694 lets the index
// choose its root; the PEP's example is `https://upload.pypi.org/2.0`. The
// path prefix keeps the token off other endpoints on the same host (pypi.org
// also serves the legacy upload API). Unverified until PyPI ships PEP 694.
const UPLOAD_ROOTS: Readonly<Record<string, readonly { origin: string; path: string }[]>> = {
  "https://pypi.org": [
    { origin: "https://upload.pypi.org", path: "/2.0/" },
    { origin: "https://pypi.org", path: "/2.0/" },
  ],
  "https://test.pypi.org": [{ origin: "https://test.pypi.org", path: "/2.0/" }],
};

const PYPI_UPLOAD_CONTENT_TYPE = "application/vnd.pypi.upload.v2+json";
const SESSION_TIMEOUT_MS = 15_000;
const UPLOAD_BYTES_TIMEOUT_MS = 120_000;
const MAX_SESSION_RESPONSE_BYTES = 1024 * 1024;
const MAX_SESSION_FILES = 1024;
const USER_AGENT = "drydock-pep694-session/0.1";
const API_META = { "api-version": "2.0" } as const;
// `http-post-bytes` is the one upload mechanism every PEP 694 server must offer.
const UPLOAD_MECHANISM = "http-post-bytes";
const DEFAULT_COMPLETION_POLL_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];

export type SessionOperation =
  | "create"
  | "status"
  | "cancel"
  | "publish"
  | "extend"
  | "file-upload"
  | "file-bytes"
  | "file-complete"
  | "file-status"
  | "file-delete";

const OPERATION_METHOD: Record<SessionOperation, "GET" | "DELETE" | "POST"> = {
  create: "POST",
  status: "GET",
  cancel: "DELETE",
  publish: "POST",
  extend: "POST",
  "file-upload": "POST",
  "file-bytes": "POST",
  "file-complete": "POST",
  "file-status": "GET",
  "file-delete": "DELETE",
};

/** The URL Drydock POSTs to create a session on `indexOrigin`, or null. */
function pyPiSessionCreateUrl(indexOrigin: string): string | null {
  const root = UPLOAD_ROOTS[indexOrigin]?.[0];
  return root ? `${root.origin}${root.path}` : null;
}

/**
 * May the token for `indexOrigin` be attached to `method url`? POST to an
 * Upload 2.0 root creates a session; anything else must sit strictly under a
 * root and use a method PEP 694 defines.
 */
export function evaluatePyPiSessionRequest(
  url: string,
  method: string,
  indexOrigin: string,
): { allowed: boolean } {
  const parsed = parseStrictHttpsUrl(url);
  if (!parsed) return { allowed: false };
  // `URL` already resolved dot segments; encoded separators could be decoded
  // differently by the server, so they are refused outright.
  if (/%2f|%5c/i.test(parsed.pathname)) return { allowed: false };
  const verb = method.toUpperCase();
  for (const root of UPLOAD_ROOTS[indexOrigin] ?? []) {
    if (parsed.origin !== root.origin || !parsed.pathname.startsWith(root.path)) continue;
    if (parsed.pathname.length === root.path.length) return { allowed: verb === "POST" };
    return { allowed: verb === "GET" || verb === "DELETE" || verb === "POST" };
  }
  return { allowed: false };
}

export class PyPiSessionError extends Error {
  constructor(
    public code:
      | "session_url_refused"
      | "session_unreachable"
      | "session_redirect_refused"
      | "session_not_found"
      | "session_conflict"
      | "session_http_error"
      | "session_malformed"
      | "upload_failed",
    message: string,
    public status: number | null = null,
  ) {
    super(message);
    this.name = "PyPiSessionError";
  }
}

type PyPiSessionStatus = "open" | "processing" | "published" | "error" | "canceled";

interface PyPiSessionFile {
  status: string;
  /** The file's `file-upload-session` link, used to delete it. */
  link: string | null;
}

export interface PyPiSessionSnapshot {
  status: PyPiSessionStatus;
  expiresAt: Date | null;
  links: {
    session: string;
    publish: string | null;
    extend: string | null;
    stage: string | null;
    upload: string | null;
  };
  files: Map<string, PyPiSessionFile>;
  /** Present only if the index echoes them; PEP 694 does not require it. */
  name: string | null;
  version: string | null;
}

export interface PyPiSessionGatewayOptions {
  token: string;
  indexOrigin: string;
  sessionUrl: string;
  fetchImpl?: typeof fetch;
  /** Waits between file-completion polls; tests shorten them. */
  completionPollDelaysMs?: number[];
}

/** One `http-post-bytes` file upload the index opened in a session. */
export interface PyPiFileUpload {
  filename: string;
  /** `links.file-upload-session`: status and delete. */
  link: string;
  complete: string;
  fileUrl: string;
}

/**
 * Bound to one session URL (or, while creating, the Upload 2.0 root) and one
 * index. Construct only through `createPyPiSessionGateway` or
 * `openPyPiSession`, which refuse a URL the policy rejects before any request.
 */
export class PyPiSessionGateway {
  private readonly token: string;
  readonly indexOrigin: string;
  readonly sessionUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly completionPollDelaysMs: number[];

  constructor(options: PyPiSessionGatewayOptions) {
    this.token = options.token;
    this.indexOrigin = options.indexOrigin;
    this.sessionUrl = options.sessionUrl;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.completionPollDelaysMs =
      options.completionPollDelaysMs ?? DEFAULT_COMPLETION_POLL_DELAYS_MS;
  }

  async status(): Promise<PyPiSessionSnapshot> {
    const response = await this.send("status", this.sessionUrl);
    return this.readSnapshot(response, "session status");
  }

  /**
   * 201 published. Any other 2xx counts as accepted but still processing and
   * is polled: only PEP 694's 201 says the release is live. 409 surfaces as
   * `session_conflict`.
   */
  async publish(snapshot: PyPiSessionSnapshot): Promise<{ status: 201 | 202 }> {
    if (!snapshot.links.publish) {
      throw new PyPiSessionError("session_malformed", "session has no publish link");
    }
    const response = await this.send("publish", snapshot.links.publish, {
      json: { meta: API_META },
    });
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status === 201 ? 201 : 202 };
  }

  async extend(
    snapshot: PyPiSessionSnapshot,
    seconds: number,
  ): Promise<PyPiSessionSnapshot | null> {
    if (!snapshot.links.extend) return null;
    const response = await this.send("extend", snapshot.links.extend, {
      json: { meta: API_META, "extend-for": Math.max(1, Math.floor(seconds)) },
    });
    return this.readSnapshot(response, "session extend");
  }

  async cancel(): Promise<void> {
    const response = await this.send("cancel", this.sessionUrl);
    await response.body?.cancel().catch(() => undefined);
  }

  /**
   * Open an `http-post-bytes` upload for one file. The declared size and
   * sha256 are the reviewed file's, so the index itself refuses other bytes.
   */
  async createFileUpload(
    snapshot: PyPiSessionSnapshot,
    file: { filename: string; size: number; sha256: string },
  ): Promise<PyPiFileUpload> {
    if (!snapshot.links.upload) {
      throw new PyPiSessionError("session_malformed", "session has no upload link");
    }
    const response = await this.send("file-upload", snapshot.links.upload, {
      json: {
        meta: API_META,
        filename: file.filename,
        size: file.size,
        hashes: { sha256: file.sha256 },
        mechanism: UPLOAD_MECHANISM,
      },
    });
    const raw = await this.readJson(response);
    const links = isRecord(raw) && isRecord(raw.links) ? raw.links : null;
    const mechanism = isRecord(raw) && isRecord(raw.mechanism) ? raw.mechanism : null;
    const link = links?.["file-upload-session"];
    const complete = links?.complete;
    const fileUrl = mechanism?.file_url;
    if (
      typeof link !== "string" ||
      typeof complete !== "string" ||
      typeof fileUrl !== "string" ||
      mechanism?.identifier !== UPLOAD_MECHANISM
    ) {
      throw new PyPiSessionError(
        "session_malformed",
        `file upload for ${file.filename} is not a PEP 694 ${UPLOAD_MECHANISM} upload`,
      );
    }
    return { filename: file.filename, link, complete, fileUrl };
  }

  /** POST the reviewed bytes to the upload's `file_url`, under the same policy as every link. */
  async uploadFileBytes(upload: PyPiFileUpload, bytes: Uint8Array): Promise<void> {
    const response = await this.send("file-bytes", upload.fileUrl, { bytes });
    await response.body?.cancel().catch(() => undefined);
  }

  /**
   * Mark the upload complete and wait for the index to process it. Anything
   * but `completed` within the poll budget is `upload_failed`.
   */
  async completeFileUpload(upload: PyPiFileUpload): Promise<void> {
    const response = await this.send("file-complete", upload.complete, {
      json: { meta: API_META },
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 201) return;
    for (const delay of this.completionPollDelaysMs) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      const status = await this.fileUploadStatus(upload.link);
      if (status === "completed") return;
      if (status !== "processing" && status !== "pending") {
        throw new PyPiSessionError(
          "upload_failed",
          `the index reported ${upload.filename} as ${status}`,
        );
      }
    }
    throw new PyPiSessionError(
      "upload_failed",
      `the index did not finish processing ${upload.filename} in time`,
    );
  }

  private async fileUploadStatus(link: string): Promise<string> {
    const raw = await this.readJson(await this.send("file-status", link));
    if (!isRecord(raw) || typeof raw.status !== "string") {
      throw new PyPiSessionError("session_malformed", "file upload status is not PEP 694");
    }
    return raw.status;
  }

  /** Delete one file from the session; an already-gone file counts as deleted. */
  async deleteFile(link: string): Promise<void> {
    try {
      const response = await this.send("file-delete", link);
      await response.body?.cancel().catch(() => undefined);
    } catch (err) {
      if (err instanceof PyPiSessionError && err.code === "session_not_found") return;
      throw err;
    }
  }

  /** Create the session on a root-bound gateway; see `openPyPiSession`. */
  async createSession(release: {
    name: string;
    version: string;
  }): Promise<{ snapshot: PyPiSessionSnapshot } | { existing: string | null }> {
    const response = await this.send(
      "create",
      this.sessionUrl,
      { json: { meta: API_META, name: release.name, version: release.version } },
      { allowConflict: true },
    );
    if (response.status === 409) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      return { existing: location ? resolveLink(location, this.sessionUrl) : null };
    }
    return { snapshot: await this.readSnapshot(response, "session create") };
  }

  private async send(
    operation: SessionOperation,
    url: string,
    body?: { json: unknown } | { bytes: Uint8Array },
    options: { allowConflict?: boolean } = {},
  ): Promise<Response> {
    const method = OPERATION_METHOD[operation];
    // Every link comes from the index's answers; each must also stay on the
    // origin of the session (or, while creating, the root) this gateway is
    // bound to.
    if (
      !evaluatePyPiSessionRequest(url, method, this.indexOrigin).allowed ||
      parseStrictHttpsUrl(url)?.origin !== new URL(this.sessionUrl).origin
    ) {
      throw new PyPiSessionError(
        "session_url_refused",
        `session ${operation} URL is not an allowed Upload 2.0 URL for this index`,
      );
    }
    let contentType: Record<string, string> = {};
    let payload: BodyInit | undefined;
    if (body && "bytes" in body) {
      contentType = { "content-type": "application/octet-stream" };
      payload = body.bytes as BodyInit;
    } else if (body) {
      contentType = { "content-type": PYPI_UPLOAD_CONTENT_TYPE };
      payload = JSON.stringify(body.json);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(
          operation === "file-bytes" ? UPLOAD_BYTES_TIMEOUT_MS : SESSION_TIMEOUT_MS,
        ),
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: PYPI_UPLOAD_CONTENT_TYPE,
          "user-agent": USER_AGENT,
          ...contentType,
        },
        ...(payload === undefined ? {} : { body: payload }),
      });
    } catch {
      throw new PyPiSessionError(
        "session_unreachable",
        `session ${operation} could not be reached`,
      );
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new PyPiSessionError(
        "session_redirect_refused",
        `session ${operation} answered with a redirect, which is never followed with a token`,
        response.status,
      );
    }
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel().catch(() => undefined);
      throw new PyPiSessionError(
        "session_not_found",
        `session ${operation}: session not found`,
        response.status,
      );
    }
    if (response.status === 409 && options.allowConflict) return response;
    if (response.status === 409) {
      await response.body?.cancel().catch(() => undefined);
      throw new PyPiSessionError(
        "session_conflict",
        `session ${operation} conflicted (HTTP 409)`,
        409,
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new PyPiSessionError(
        "session_http_error",
        `session ${operation} answered HTTP ${response.status}`,
        response.status,
      );
    }
    return response;
  }

  private readJson(response: Response): Promise<unknown> {
    return readBoundedJson(response, {
      maxBytes: MAX_SESSION_RESPONSE_BYTES,
      deadlineMs: Date.now() + SESSION_TIMEOUT_MS,
    });
  }

  private async readSnapshot(response: Response, what: string): Promise<PyPiSessionSnapshot> {
    const snapshot = parseSessionSnapshot(await this.readJson(response));
    if (!snapshot)
      throw new PyPiSessionError("session_malformed", `${what} is not a PEP 694 session`);
    return snapshot;
  }
}

export function createPyPiSessionGateway(options: PyPiSessionGatewayOptions): PyPiSessionGateway {
  if (!evaluatePyPiSessionRequest(options.sessionUrl, "GET", options.indexOrigin).allowed) {
    throw new PyPiSessionError(
      "session_url_refused",
      "session URL is not an allowed Upload 2.0 URL for this index",
    );
  }
  return new PyPiSessionGateway(options);
}

/**
 * Create the session for `name`/`version` on the token's index, or adopt the
 * one the index says already exists (PEP 694 answers 409 with its
 * `Location`). The returned gateway is bound to the index-issued session URL,
 * which must be on the root's origin and pass the policy before any
 * token-bearing request goes to it.
 */
export async function openPyPiSession(
  options: Omit<PyPiSessionGatewayOptions, "sessionUrl">,
  release: { name: string; version: string },
): Promise<{ gateway: PyPiSessionGateway; snapshot: PyPiSessionSnapshot; adopted: boolean }> {
  const createUrl = pyPiSessionCreateUrl(options.indexOrigin);
  if (!createUrl) {
    throw new PyPiSessionError("session_url_refused", "this index has no Upload 2.0 root");
  }
  const created = await new PyPiSessionGateway({ ...options, sessionUrl: createUrl }).createSession(
    release,
  );
  const sessionUrl = "snapshot" in created ? created.snapshot.links.session : created.existing;
  if (
    !sessionUrl ||
    parseStrictHttpsUrl(sessionUrl)?.origin !== new URL(createUrl).origin ||
    !evaluatePyPiSessionRequest(sessionUrl, "GET", options.indexOrigin).allowed
  ) {
    throw new PyPiSessionError(
      "session_url_refused",
      "the index named a session outside its Upload 2.0 root",
    );
  }
  const gateway = new PyPiSessionGateway({ ...options, sessionUrl });
  const snapshot = "snapshot" in created ? created.snapshot : await gateway.status();
  if (snapshot.links.session !== sessionUrl) {
    throw new PyPiSessionError("session_malformed", "session status names a different session");
  }
  return { gateway, snapshot, adopted: !("snapshot" in created) };
}

function resolveLink(location: string, base: string): string | null {
  try {
    return new URL(location, base).toString();
  } catch {
    return null;
  }
}

const SESSION_STATUSES = new Set<PyPiSessionStatus>([
  "open",
  "processing",
  "published",
  "error",
  "canceled",
]);

export function parseSessionSnapshot(raw: unknown): PyPiSessionSnapshot | null {
  if (!isRecord(raw) || !isRecord(raw.meta) || !isRecord(raw.links)) return null;
  const apiVersion = raw.meta["api-version"];
  if (typeof apiVersion !== "string" || !/^2\.\d+$/.test(apiVersion)) return null;
  if (typeof raw.status !== "string" || !SESSION_STATUSES.has(raw.status as PyPiSessionStatus)) {
    return null;
  }
  const session = raw.links.session;
  if (typeof session !== "string") return null;
  const files = new Map<string, PyPiSessionFile>();
  if (raw.files !== undefined) {
    if (!isRecord(raw.files)) return null;
    const entries = Object.entries(raw.files);
    if (entries.length > MAX_SESSION_FILES) return null;
    for (const [filename, file] of entries) {
      if (!isRecord(file) || typeof file.status !== "string") return null;
      files.set(filename, {
        status: file.status,
        link: typeof file.link === "string" ? file.link : null,
      });
    }
  }
  const expires = typeof raw["expires-at"] === "string" ? Date.parse(raw["expires-at"]) : NaN;
  const link = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    status: raw.status as PyPiSessionStatus,
    expiresAt: Number.isFinite(expires) ? new Date(expires) : null,
    links: {
      session,
      publish: link(raw.links.publish),
      extend: link(raw.links.extend),
      stage: link(raw.links.stage),
      upload: link(raw.links.upload),
    },
    files,
    name: typeof raw.name === "string" ? raw.name : null,
    version: typeof raw.version === "string" ? raw.version : null,
  };
}

/**
 * Does the index's session answer describe the release Drydock reviewed?
 *
 * PEP 694 session responses do not echo the project, so the binding is: the
 * session's own `links.stage` is the stage Drydock read (whose page is the
 * project's and whose files are the version's), its file set is exactly the
 * reviewed filenames, every file is `completed`, and any echoed name/version
 * agree. Returns maintainer-facing problems; empty means bound.
 */
export function sessionBindingProblems(
  snapshot: PyPiSessionSnapshot,
  expected: { project: string; version: string; stageUrl: string; filenames: string[] },
  options: { requireOpen: boolean } = { requireOpen: true },
): string[] {
  const problems: string[] = [];
  if (options.requireOpen && snapshot.status !== "open") {
    problems.push(`session is ${snapshot.status}, not open`);
  }
  if (snapshot.links.stage !== expected.stageUrl) {
    problems.push("session's stage link is not the stage Drydock reviewed");
  }
  if (
    snapshot.name !== null &&
    normalizePyPiProjectName(snapshot.name) !== normalizePyPiProjectName(expected.project)
  ) {
    problems.push(`session is for project ${snapshot.name}, not ${expected.project}`);
  }
  if (snapshot.version !== null && !pyPiVersionsEquivalent(snapshot.version, expected.version)) {
    problems.push(`session is for version ${snapshot.version}, not ${expected.version}`);
  }
  const reviewed = new Set(expected.filenames);
  for (const [filename, file] of snapshot.files) {
    if (!reviewed.has(filename))
      problems.push(`${filename} is in the session but was not reviewed`);
    else if (file.status !== "completed")
      problems.push(`${filename} is ${file.status} in the session`);
  }
  for (const filename of reviewed) {
    if (!snapshot.files.has(filename))
      problems.push(`${filename} was reviewed but is not in the session`);
  }
  return problems;
}

/** Truncated SHA-256 of a session URL: correlates rows without storing the URL. */
export async function sessionFingerprint(sessionUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionUrl));
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
