// A fetch double shaped like Verdaccio 7's experimental staged publishing
// (`flags: { stage: true }`). Every body, status, and paging rule below was
// captured from a real Verdaccio 7.0.2 instance driven by npm 11.21.1; see
// docs/npm-staged-publishing.md#verdaccio. It is a double for Drydock's
// requests, not a registry: write endpoints are not modeled.

export interface VerdaccioStageRecord {
  id: string;
  packageName: string;
  version: string;
  tag: string;
  createdAt: string;
  actor: string;
  actorType: "user";
  access: "public" | "private";
  shasum: string;
}

interface VerdaccioRequest {
  url: string;
  method: string;
  authorization: string | null;
  range: string | null;
}

export interface VerdaccioFakeOptions {
  /** Origin plus optional reverse-proxy base path, e.g. `https://npm.example.test/npm`. */
  registryUrl: string;
  /** Bearer token Verdaccio accepts. Anything else is anonymous (401). */
  token: string;
  username?: string;
  stages: VerdaccioStageRecord[];
  /** Stage ids the token's user may not publish; Verdaccio hides them as 404. */
  hiddenStageIds?: string[];
  /**
   * Stage ids still in the list response but gone by the next request, the
   * window in which a maintainer approves or rejects between Drydock's list
   * and its per-stage reads. Verdaccio answers both cases with the same 404.
   */
  vanishedStageIds?: string[];
  /** Published versions, answered as `published` by the version-status route. */
  published?: Record<string, string[]>;
}

// Verdaccio constrains `:stageId` to a UUID; a non-UUID never reaches the stage
// handler and gets the router's generic 404.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_PER_PAGE = 10;
const MAX_PER_PAGE = 100;

export function verdaccioStage(
  overrides: Partial<VerdaccioStageRecord> & Pick<VerdaccioStageRecord, "id">,
): VerdaccioStageRecord {
  return {
    packageName: "drydock-verd-demo",
    version: "1.1.0",
    tag: "latest",
    createdAt: "2026-10-31T14:49:35.777Z",
    actor: "bob",
    actorType: "user",
    access: "public",
    shasum: "3a3cd7e49d16f447f0e14a482d0c0e9bcc343457",
    ...overrides,
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

const UNAUTHORIZED_STAGE = () =>
  json({ error: "You must be logged in to publish packages." }, 401, {
    "www-authenticate": "Bearer",
  });
const NO_SUCH_STAGE = () => json({ error: "no such staged package version" }, 404);
const RESOURCE_NOT_FOUND = () => json({ error: "resource not found" }, 404);

export function createVerdaccioFake(options: VerdaccioFakeOptions) {
  const base = new URL(options.registryUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const hidden = new Set(options.hiddenStageIds ?? []);
  const vanished = new Set(options.vanishedStageIds ?? []);
  const requests: VerdaccioRequest[] = [];
  const visibleStages = () => options.stages.filter((stage) => !hidden.has(stage.id));

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const authorization = request.headers.get("authorization");
    requests.push({
      url: request.url,
      method: request.method,
      authorization,
      range: request.headers.get("range"),
    });
    if (url.origin !== base.origin || !url.pathname.startsWith(`${basePath}/`)) {
      throw new Error(`request outside the Verdaccio fake: ${request.url}`);
    }
    const path = url.pathname.slice(basePath.length);
    const authed = authorization === `Bearer ${options.token}`;

    if (path === "/-/whoami") {
      if (!authed) return json({ error: "Unauthorized" }, 401, { "www-authenticate": "Bearer" });
      return json({ username: options.username ?? "alice" });
    }

    if (path === "/-/stage") {
      if (!authed) return UNAUTHORIZED_STAGE();
      // `page` is zero-based and `total` counts only what this user may see,
      // so `npm stage list` can loop until items.length >= total.
      const rawPage = Number.parseInt(url.searchParams.get("page") ?? "", 10);
      const rawPerPage = Number.parseInt(url.searchParams.get("perPage") ?? "", 10);
      const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 0;
      const perPage =
        Number.isFinite(rawPerPage) && rawPerPage > 0
          ? Math.min(rawPerPage, MAX_PER_PAGE)
          : DEFAULT_PER_PAGE;
      const filter = url.searchParams.get("package");
      const items = visibleStages().filter((stage) => !filter || stage.packageName === filter);
      return json({
        items: items
          .slice(page * perPage, page * perPage + perPage)
          .map((stage) => ({ ...stage, status: "staged" })),
        page,
        perPage,
        total: items.length,
      });
    }

    const stageMatch = /^\/-\/stage\/([^/]+)(\/tarball)?$/.exec(path);
    if (stageMatch) {
      const [, stageId, tarball] = stageMatch;
      if (!UUID.test(stageId)) return RESOURCE_NOT_FOUND();
      if (!authed) return UNAUTHORIZED_STAGE();
      const stage = visibleStages().find((candidate) => candidate.id === stageId);
      if (!stage || vanished.has(stageId)) return NO_SUCH_STAGE();
      if (!tarball) return json({ ...stage, status: "staged" });
      // Verdaccio ignores `Range` and streams the whole tarball with a 200.
      const bytes = new Uint8Array([0x1f, 0x8b]);
      return new Response(bytes, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(bytes.byteLength),
        },
      });
    }

    const statusMatch = /^\/-\/package\/([^/]+)\/version\/([^/]+)\/status$/.exec(path);
    if (statusMatch) {
      if (!authed) return json({ error: "You must be logged in to publish packages." }, 401);
      const packageName = decodeURIComponent(statusMatch[1]);
      const version = decodeURIComponent(statusMatch[2]);
      // Only `published` and `staged` exist; a rejected or unknown version is a
      // 404, as is one the user may not publish.
      if (options.published?.[packageName]?.includes(version)) {
        return json({ packageName, version, status: "published" });
      }
      const staged = visibleStages().some(
        (stage) => stage.packageName === packageName && stage.version === version,
      );
      if (staged) return json({ packageName, version, status: "staged" });
      return json({ error: "no such package version" }, 404);
    }

    return RESOURCE_NOT_FOUND();
  }

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) =>
    handle(input instanceof Request ? input : new Request(input, init));

  return { fetch, requests };
}
