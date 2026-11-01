// Fake PEP 694 (Upload 2.0) stage index. Produces fetch routes keyed by URL
// prefix, for `stubGithubFetch({ routes })` or `stubFetchRoutes`. The stage
// token is a recognizable string so suites can assert it never leaks.

export const FAKE_STAGE_TOKEN = "stgtok-6f1d0c2b9a7e4d31";

export interface FakeStageFile {
  filename: string;
  bytes: Uint8Array;
  /** Declared digest override; defaults to the sha256 of `bytes`. */
  declaredSha256?: string;
  /** Absolute download URL override (e.g. an off-allowlist host). */
  url?: string;
  /** PEP 700 `size` the JSON page declares; omitted when unset. */
  size?: number;
}

export interface FakeStageOptions {
  project: string;
  files: FakeStageFile[];
  indexOrigin?: string;
  fileOrigin?: string;
  token?: string;
  format?: "json" | "html";
  /** Replace the project page response entirely. */
  page?: () => Response | Promise<Response>;
  /** Replace one staged file's download response. */
  file?: (filename: string) => Response | Promise<Response> | null;
}

export interface FakeStage {
  stageUrl: string;
  routes: Record<string, (request: Request) => Response | Promise<Response>>;
  requests: string[];
}

export async function sha256HexOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildFakeStage(options: FakeStageOptions): Promise<FakeStage> {
  const indexOrigin = options.indexOrigin ?? "https://pypi.org";
  const fileOrigin = options.fileOrigin ?? "https://files.pythonhosted.org";
  const token = options.token ?? FAKE_STAGE_TOKEN;
  const normalized = options.project.toLowerCase().replace(/[-_.]+/g, "-");
  const stageRoot = `${indexOrigin}/stage/${token}/`;
  const filesRoot = `${fileOrigin}/stage-files/${token}/`;
  const requests: string[] = [];
  const entries = await Promise.all(
    options.files.map(async (file) => ({
      file,
      sha256: file.declaredSha256 ?? (await sha256HexOf(file.bytes)),
      url: file.url ?? `${filesRoot}${file.filename}`,
    })),
  );

  const page = (): Response => {
    if (options.format === "html") {
      const anchors = entries
        .map(
          (entry) =>
            `<a href="${entry.url}#sha256=${entry.sha256}">${entry.file.filename}</a><br/>`,
        )
        .join("\n");
      return new Response(`<!DOCTYPE html><html><body>${anchors}</body></html>`, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response(
      JSON.stringify({
        meta: { "api-version": "1.1" },
        name: normalized,
        files: entries.map((entry) => ({
          filename: entry.file.filename,
          url: entry.url,
          hashes: { sha256: entry.sha256 },
          ...(entry.file.size === undefined ? {} : { size: entry.file.size }),
        })),
      }),
      { headers: { "content-type": "application/vnd.pypi.simple.v1+json" } },
    );
  };

  return {
    stageUrl: stageRoot,
    requests,
    routes: {
      [stageRoot]: async (request) => {
        requests.push(request.url);
        if (request.url !== `${stageRoot}${normalized}/`) {
          return new Response("not found", { status: 404 });
        }
        return options.page ? options.page() : page();
      },
      [filesRoot]: async (request) => {
        requests.push(request.url);
        const filename = request.url.slice(filesRoot.length);
        const override = options.file?.(filename);
        if (override) return override;
        const entry = entries.find((candidate) => candidate.file.filename === filename);
        if (!entry) return new Response("not found", { status: 404 });
        return new Response(entry.file.bytes as BodyInit, {
          headers: { "content-type": "application/octet-stream" },
        });
      },
    },
  };
}

// ── Fake Upload 2.0 server (mode B) ───────────────────────────────────────────

export const FAKE_SESSION_TOKEN = "sesstok-9c4e2a7b1d3f";

/**
 * A recognizable project-scoped PyPI token: a macaroon-shaped body whose
 * caveat restricts it to `projects`. Suites assert this string never leaks.
 */
export function fakePyPiToken(projects: string[] | "user" = ["demo-package"]): string {
  const caveat =
    projects === "user" ? `[3,"0000-user"]` : `[1,[${projects.map((p) => `"${p}"`).join(",")}]]`;
  const body = `\x02\x01location pypi.org\x02identifier drydock-test-0001\x02cid ${caveat}\x02signature-fake-bytes`;
  return `pypi-${btoa(body).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

type FakeSessionStatus = "open" | "processing" | "published" | "error" | "canceled";
type FakePublishAnswer = 200 | 201 | 202 | 409 | 500;

interface FakeUploadFile {
  status: "pending" | "processing" | "completed" | "error";
  sha256: string;
  bytes: Uint8Array | null;
}

export interface FakeUploadSessionOptions {
  /** The session's `links.stage` (the fake stage page the suite serves). */
  stageUrl: string;
  /**
   * Files already in the session. Without `adopt`, the session exists from
   * the start (as if registered earlier); with it, create answers 409.
   */
  filenames?: string[];
  uploadOrigin?: string;
  /** A pre-existing session for the release: create answers 409 + Location. */
  adopt?: boolean;
  status?: FakeSessionStatus;
  expiresAt?: Date;
  /** How POST publish answers. `202`/`200` move to `afterPublish` on the next GET. */
  publish?: FakePublishAnswer;
  afterPublish?: "published" | "error";
  /** Override links in the session answer (e.g. an off-origin publish link). */
  links?: Partial<Record<"session" | "publish" | "extend" | "stage" | "upload", string | null>>;
  /** Override the `http-post-bytes` `file_url` for a filename. */
  fileUrl?: (filename: string, defaultUrl: string) => string;
  /** Answer `POST file_url` for a filename with this status instead of storing bytes. */
  failBytesFor?: { filename: string; status: number };
  /** Completion answers 202, then the file stays `processing` this many status reads. */
  processingReads?: number;
  /** Echoed project name/version, when the index chooses to include them. */
  echo?: { name: string; version: string };
  /** Replace any response (e.g. a redirect); return null to fall through. */
  respond?: (request: Request) => Response | Promise<Response> | null;
}

export interface FakeUploadSession {
  createUrl: string;
  sessionUrl: string;
  routes: Record<string, (request: Request) => Response | Promise<Response>>;
  requests: Array<{ method: string; url: string; authorization: string | null }>;
  state: {
    created: boolean;
    status: FakeSessionStatus;
    expiresAt: Date;
    files: Map<string, FakeUploadFile>;
    publish: FakePublishAnswer;
    gone: boolean;
  };
  /** sha256 of every completed file, as the stage page would list them. */
  completedDigests(): Map<string, string>;
}

/**
 * Upload 2.0 server for one release. Routes are keyed by the Upload 2.0 root,
 * so the create POST and every session URL land here; unknown session paths
 * answer 503 (never 404), because the cron sweeps every organization's held
 * sessions and must not settle another suite's rows on this fake's answers.
 */
export function buildFakeUploadSession(options: FakeUploadSessionOptions): FakeUploadSession {
  const uploadOrigin = options.uploadOrigin ?? "https://upload.pypi.org";
  const createUrl = `${uploadOrigin}/2.0/`;
  const sessionUrl = `${createUrl}sessions/${FAKE_SESSION_TOKEN}-${crypto.randomUUID().slice(0, 8)}`;
  const requests: FakeUploadSession["requests"] = [];
  let pendingAfterPublish = false;
  const processingLeft = new Map<string, number>();
  const preexisting = options.filenames ?? [];
  const state: FakeUploadSession["state"] = {
    created: preexisting.length > 0 || options.adopt === true,
    status: options.status ?? "open",
    expiresAt: options.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    files: new Map(
      preexisting.map((filename) => [
        filename,
        { status: "completed", sha256: "e".repeat(64), bytes: null },
      ]),
    ),
    publish: options.publish ?? 201,
    gone: false,
  };
  const links = () => ({
    session: sessionUrl,
    publish: `${sessionUrl}/publish`,
    extend: `${sessionUrl}/extend`,
    stage: options.stageUrl,
    upload: `${sessionUrl}/files`,
    ...options.links,
  });
  const fileLink = (filename: string) => `${sessionUrl}/files/${filename}`;
  const body = (status = 200) =>
    Response.json(
      {
        meta: { "api-version": "2.0" },
        status: state.status,
        "expires-at": state.expiresAt.toISOString(),
        links: links(),
        files: Object.fromEntries(
          [...state.files].map(([filename, file]) => [
            filename,
            { status: file.status, link: fileLink(filename) },
          ]),
        ),
        ...(options.echo ? { name: options.echo.name, version: options.echo.version } : {}),
      },
      {
        status,
        headers: {
          "content-type": "application/vnd.pypi.upload.v2+json",
          ...(status === 201 ? { location: sessionUrl } : {}),
        },
      },
    );

  const handle = async (request: Request): Promise<Response> => {
    const { url, method } = request;
    if (url === createUrl && method === "POST") {
      if (state.created) {
        return new Response("exists", { status: 409, headers: { location: sessionUrl } });
      }
      state.created = true;
      return body(201);
    }
    if (!url.startsWith(sessionUrl)) return new Response("unknown session", { status: 503 });
    if (state.gone || !state.created) return new Response("gone", { status: 404 });
    if (url === sessionUrl && method === "GET") {
      if (pendingAfterPublish) {
        state.status = options.afterPublish ?? "published";
        pendingAfterPublish = false;
      }
      return body();
    }
    if (url === sessionUrl && method === "DELETE") {
      state.status = "canceled";
      return new Response(null, { status: 204 });
    }
    if (url === `${sessionUrl}/publish` && method === "POST") {
      if (state.publish === 201) {
        state.status = "published";
        return new Response(null, { status: 201 });
      }
      if (state.publish === 202 || state.publish === 200) {
        state.status = "processing";
        pendingAfterPublish = true;
        return new Response(null, { status: state.publish });
      }
      return new Response("refused", { status: state.publish });
    }
    if (url === `${sessionUrl}/extend` && method === "POST") {
      const payload = (await request.json()) as { "extend-for"?: number };
      state.expiresAt = new Date(Date.now() + (payload["extend-for"] ?? 0) * 1000);
      return body();
    }
    if (url === `${sessionUrl}/files` && method === "POST") {
      const payload = (await request.json()) as {
        filename: string;
        hashes: { sha256: string };
        mechanism: string;
      };
      if (state.files.has(payload.filename)) return new Response("exists", { status: 409 });
      if (payload.mechanism !== "http-post-bytes") return new Response("no", { status: 422 });
      state.files.set(payload.filename, {
        status: "pending",
        sha256: payload.hashes.sha256,
        bytes: null,
      });
      const defaultUrl = `${fileLink(payload.filename)}/bytes`;
      return Response.json(
        {
          meta: { "api-version": "2.0" },
          status: "pending",
          links: {
            "file-upload-session": fileLink(payload.filename),
            complete: `${fileLink(payload.filename)}/complete`,
          },
          mechanism: {
            identifier: "http-post-bytes",
            file_url: options.fileUrl?.(payload.filename, defaultUrl) ?? defaultUrl,
          },
        },
        { status: 202 },
      );
    }
    const fileMatch = /\/files\/([^/]+)(\/bytes|\/complete)?$/.exec(url.slice(sessionUrl.length));
    const filename = fileMatch?.[1];
    const file = filename ? state.files.get(filename) : undefined;
    if (!filename || !file) return new Response("not found", { status: 404 });
    const action = fileMatch?.[2] ?? "";
    if (action === "/bytes" && method === "POST") {
      if (options.failBytesFor?.filename === filename) {
        return new Response("upload broke", { status: options.failBytesFor.status });
      }
      file.bytes = new Uint8Array(await request.arrayBuffer());
      return new Response(null, { status: 204 });
    }
    if (action === "/complete" && method === "POST") {
      if (!file.bytes || (await sha256HexOf(file.bytes)) !== file.sha256) {
        file.status = "error";
        return new Response("hash mismatch", { status: 400 });
      }
      if (options.processingReads) {
        file.status = "processing";
        processingLeft.set(filename, options.processingReads);
        return new Response(null, { status: 202 });
      }
      file.status = "completed";
      return new Response(null, { status: 201 });
    }
    if (action === "" && method === "GET") {
      const left = processingLeft.get(filename) ?? 0;
      if (file.status === "processing" && left <= 0) file.status = "completed";
      processingLeft.set(filename, left - 1);
      return Response.json({ meta: { "api-version": "2.0" }, status: file.status });
    }
    if (action === "" && method === "DELETE") {
      state.files.delete(filename);
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  };

  return {
    createUrl,
    sessionUrl,
    requests,
    state,
    completedDigests: () =>
      new Map(
        [...state.files]
          .filter(([, file]) => file.status === "completed")
          .map(([filename, file]) => [filename, file.sha256]),
      ),
    routes: {
      [createUrl]: async (request) => {
        // Other suites' session URLs share the root; they are not this session's requests.
        if (request.url !== createUrl && !request.url.startsWith(sessionUrl)) {
          return new Response("unknown session", { status: 503 });
        }
        requests.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.get("authorization"),
        });
        const override = await options.respond?.(request);
        return override ?? handle(request);
      },
    },
  };
}

export function stageReference(
  entries: Array<{ name: string; version: string; stageUrl: string }>,
): string {
  return JSON.stringify({
    schema: "drydock.pypi-stage.v1",
    stages: entries.map((entry) => ({
      name: entry.name,
      version: entry.version,
      "stage-url": entry.stageUrl,
    })),
  });
}

/** A mode B opt-in: Drydock creates and holds the session. */
export function drydockSessionReference(
  entries: Array<{ name: string; version: string; index?: string }>,
): string {
  return JSON.stringify({
    schema: "drydock.pypi-stage.v1",
    stages: entries.map((entry) => ({
      name: entry.name,
      version: entry.version,
      session: "drydock",
      ...(entry.index ? { index: entry.index } : {}),
    })),
  });
}
