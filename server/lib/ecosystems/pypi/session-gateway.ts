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
 *   origin for the token's own index, and only for the session operations PEP
 *   694 defines (GET/DELETE `links.session`, POST `links.publish`, POST
 *   `links.extend`);
 * - `links.publish` / `links.extend` are taken from the index's own session
 *   status answer, never from the workflow, and only after that answer binds
 *   the session to the reviewed stage (`links.stage`) and project;
 * - token-bearing requests never follow redirects: a 3xx is an error, so a
 *   `Location` cannot carry the token anywhere.
 *
 * The session URL arrives in a workflow-controlled artifact. A URL that fails
 * the policy never receives the token. Errors name the operation, never URLs.
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
const MAX_SESSION_RESPONSE_BYTES = 1024 * 1024;
const MAX_SESSION_FILES = 1024;
const USER_AGENT = "drydock-pep694-session/0.1";

export type SessionOperation = "status" | "cancel" | "publish" | "extend";

const OPERATION_METHOD: Record<SessionOperation, "GET" | "DELETE" | "POST"> = {
  status: "GET",
  cancel: "DELETE",
  publish: "POST",
  extend: "POST",
};

/** May the token for `indexOrigin` be attached to `method url`? */
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
  const roots = UPLOAD_ROOTS[indexOrigin] ?? [];
  const underRoot = roots.some(
    (root) =>
      parsed.origin === root.origin &&
      parsed.pathname.startsWith(root.path) &&
      parsed.pathname.length > root.path.length,
  );
  if (!underRoot) return { allowed: false };
  const allowedMethods = new Set(Object.values(OPERATION_METHOD));
  return { allowed: allowedMethods.has(method.toUpperCase() as "GET") };
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
      | "session_malformed",
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
}

export interface PyPiSessionSnapshot {
  status: PyPiSessionStatus;
  expiresAt: Date | null;
  links: { session: string; publish: string | null; extend: string | null; stage: string | null };
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
}

/**
 * Bound to one session URL and one index. Construct only through
 * `createPyPiSessionGateway`, which refuses a URL the policy rejects before
 * any request is made.
 */
export class PyPiSessionGateway {
  private readonly token: string;
  readonly indexOrigin: string;
  readonly sessionUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PyPiSessionGatewayOptions) {
    this.token = options.token;
    this.indexOrigin = options.indexOrigin;
    this.sessionUrl = options.sessionUrl;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async status(): Promise<PyPiSessionSnapshot> {
    const response = await this.send("status", this.sessionUrl);
    return this.readSnapshot(response, "session status");
  }

  /** 201 published, 202 processing; 409 surfaces as `session_conflict`. */
  async publish(snapshot: PyPiSessionSnapshot): Promise<{ status: 201 | 202 }> {
    if (!snapshot.links.publish) {
      throw new PyPiSessionError("session_malformed", "session has no publish link");
    }
    const response = await this.send("publish", snapshot.links.publish, {
      meta: { "api-version": "2.0" },
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 201 || response.status === 202) return { status: response.status };
    return { status: 201 };
  }

  async extend(
    snapshot: PyPiSessionSnapshot,
    seconds: number,
  ): Promise<PyPiSessionSnapshot | null> {
    if (!snapshot.links.extend) return null;
    const response = await this.send("extend", snapshot.links.extend, {
      meta: { "api-version": "2.0" },
      "extend-for": Math.max(1, Math.floor(seconds)),
    });
    return this.readSnapshot(response, "session extend");
  }

  async cancel(): Promise<void> {
    const response = await this.send("cancel", this.sessionUrl);
    await response.body?.cancel().catch(() => undefined);
  }

  private async send(operation: SessionOperation, url: string, body?: unknown): Promise<Response> {
    const method = OPERATION_METHOD[operation];
    // Publish/extend links come from the index's answer; they must also stay
    // on the session's own origin.
    if (
      !evaluatePyPiSessionRequest(url, method, this.indexOrigin).allowed ||
      parseStrictHttpsUrl(url)?.origin !== new URL(this.sessionUrl).origin
    ) {
      throw new PyPiSessionError(
        "session_url_refused",
        `session ${operation} URL is not an allowed Upload 2.0 URL for this index`,
      );
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: PYPI_UPLOAD_CONTENT_TYPE,
          "user-agent": USER_AGENT,
          ...(body === undefined ? {} : { "content-type": PYPI_UPLOAD_CONTENT_TYPE }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

  private async readSnapshot(response: Response, what: string): Promise<PyPiSessionSnapshot> {
    const raw = await readBoundedJson(response, {
      maxBytes: MAX_SESSION_RESPONSE_BYTES,
      deadlineMs: Date.now() + SESSION_TIMEOUT_MS,
    });
    const snapshot = parseSessionSnapshot(raw);
    if (!snapshot)
      throw new PyPiSessionError("session_malformed", `${what} is not a PEP 694 session`);
    return snapshot;
  }
}

export function createPyPiSessionGateway(options: PyPiSessionGatewayOptions): PyPiSessionGateway {
  if (!evaluatePyPiSessionRequest(options.sessionUrl, "GET", options.indexOrigin).allowed) {
    throw new PyPiSessionError(
      "session_url_refused",
      "session-url is not an allowed Upload 2.0 URL for this index",
    );
  }
  return new PyPiSessionGateway(options);
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
      files.set(filename, { status: file.status });
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
