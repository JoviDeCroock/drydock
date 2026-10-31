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
