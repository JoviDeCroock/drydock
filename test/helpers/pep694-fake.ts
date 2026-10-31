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

// ── Fake Upload 2.0 session server (mode B) ───────────────────────────────────

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

export interface FakeUploadSessionOptions {
  stageUrl: string;
  filenames: string[];
  uploadOrigin?: string;
  status?: FakeSessionStatus;
  expiresAt?: Date;
  /** How POST publish answers. `202` moves to `afterPublish` on the next GET. */
  publish?: 201 | 202 | 409 | 500;
  afterPublish?: "published" | "error";
  /** Override links in the session answer (e.g. an off-origin publish link). */
  links?: Partial<Record<"session" | "publish" | "extend" | "stage", string | null>>;
  /** Echoed project name/version, when the index chooses to include them. */
  echo?: { name: string; version: string };
  /** Replace every response for this session (e.g. a redirect). */
  respond?: (request: Request) => Response | Promise<Response> | null;
}

export interface FakeUploadSession {
  sessionUrl: string;
  routes: Record<string, (request: Request) => Response | Promise<Response>>;
  requests: Array<{ method: string; url: string; authorization: string | null }>;
  state: {
    status: FakeSessionStatus;
    expiresAt: Date;
    files: Map<string, string>;
    publish: 201 | 202 | 409 | 500;
    gone: boolean;
  };
}

export function buildFakeUploadSession(options: FakeUploadSessionOptions): FakeUploadSession {
  const uploadOrigin = options.uploadOrigin ?? "https://upload.pypi.org";
  // Unique per instance: the cron sweeps every organization's held sessions,
  // so suites sharing one D1 must not answer each other's session URLs.
  const sessionUrl = `${uploadOrigin}/2.0/sessions/${FAKE_SESSION_TOKEN}-${crypto.randomUUID().slice(0, 8)}`;
  const requests: FakeUploadSession["requests"] = [];
  let pendingAfterPublish = false;
  const state: FakeUploadSession["state"] = {
    status: options.status ?? "open",
    expiresAt: options.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    files: new Map(options.filenames.map((filename) => [filename, "completed"])),
    publish: options.publish ?? 201,
    gone: false,
  };
  const links = {
    session: sessionUrl,
    publish: `${sessionUrl}/publish`,
    extend: `${sessionUrl}/extend`,
    stage: options.stageUrl,
    ...options.links,
  };
  const body = () =>
    Response.json(
      {
        meta: { "api-version": "2.0" },
        status: state.status,
        "expires-at": state.expiresAt.toISOString(),
        links: { ...links, upload: `${sessionUrl}/files` },
        files: Object.fromEntries(
          [...state.files].map(([filename, status]) => [
            filename,
            { status, link: `${sessionUrl}/files/${filename}` },
          ]),
        ),
        ...(options.echo ? { name: options.echo.name, version: options.echo.version } : {}),
      },
      { headers: { "content-type": "application/vnd.pypi.upload.v2+json" } },
    );

  return {
    sessionUrl,
    requests,
    state,
    routes: {
      [sessionUrl]: async (request) => {
        requests.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.get("authorization"),
        });
        const override = options.respond?.(request);
        if (override) return override;
        if (state.gone) return new Response("gone", { status: 404 });
        if (request.url === sessionUrl && request.method === "GET") {
          if (pendingAfterPublish) {
            state.status = options.afterPublish ?? "published";
            pendingAfterPublish = false;
          }
          return body();
        }
        if (request.url === sessionUrl && request.method === "DELETE") {
          state.status = "canceled";
          return new Response(null, { status: 204 });
        }
        if (request.url === `${sessionUrl}/publish` && request.method === "POST") {
          if (state.publish === 201) {
            state.status = "published";
            return new Response(null, { status: 201 });
          }
          if (state.publish === 202) {
            state.status = "processing";
            pendingAfterPublish = true;
            return new Response(null, { status: 202 });
          }
          return new Response("refused", { status: state.publish });
        }
        if (request.url === `${sessionUrl}/extend` && request.method === "POST") {
          const payload = (await request.json()) as { "extend-for"?: number };
          state.expiresAt = new Date(Date.now() + (payload["extend-for"] ?? 0) * 1000);
          return body();
        }
        return new Response("not found", { status: 404 });
      },
    },
  };
}

export function stageReference(
  entries: Array<{ name: string; version: string; stageUrl: string; sessionUrl?: string }>,
): string {
  return JSON.stringify({
    schema: "drydock.pypi-stage.v1",
    stages: entries.map((entry) => ({
      name: entry.name,
      version: entry.version,
      "stage-url": entry.stageUrl,
      ...(entry.sessionUrl ? { "session-url": entry.sessionUrl } : {}),
    })),
  });
}
