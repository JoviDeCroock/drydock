import { WorkerEntrypoint } from "cloudflare:workers";
import { loadPublicPackageDiff, PublicDiffError, type PublicPackageDiff } from "./public-diff";
import { isValidNpmPackageName } from "./registry";

export const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org";
export const PUBLIC_DIFF_PATH = "/api/public/v1/package-diff";

const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const EDGE_CACHE_CONTROL = "public, max-age=86400, stale-while-revalidate=604800";
const BROWSER_CACHE_CONTROL = "public, max-age=0, must-revalidate";
const NO_STORE = "private, no-store";

export interface PublicDiffPairInput {
  packageName: string;
  fromVersion: string;
  toVersion: string;
  registryUrl: typeof PUBLIC_NPM_REGISTRY;
}

export type PublicDiffPairInputResult =
  | { input: PublicDiffPairInput }
  | { error: string; status: 400 };

export function parsePublicDiffPairInput(searchParams: URLSearchParams): PublicDiffPairInputResult {
  const packageName = searchParams.get("package")?.trim() ?? "";
  if (!isValidNpmPackageName(packageName)) {
    return { error: "invalid package name", status: 400 };
  }

  const fromVersion = searchParams.get("from")?.trim() ?? "";
  if (!VERSION_RE.test(fromVersion)) {
    return { error: "invalid from version", status: 400 };
  }

  const toVersion = searchParams.get("to")?.trim() ?? "";
  if (!VERSION_RE.test(toVersion)) {
    return { error: "invalid to version", status: 400 };
  }
  if (fromVersion === toVersion) {
    return { error: "from and to must differ", status: 400 };
  }

  return {
    input: {
      packageName,
      fromVersion,
      toVersion,
      registryUrl: PUBLIC_NPM_REGISTRY,
    },
  };
}

export function canonicalPublicDiffPairRequest(
  request: Request,
  input: PublicDiffPairInput,
): Request {
  const url = new URL(request.url);
  url.pathname = PUBLIC_DIFF_PATH;
  url.search = new URLSearchParams({
    package: input.packageName,
    from: input.fromVersion,
    to: input.toVersion,
  }).toString();
  url.hash = "";

  // This is an anonymous public-registry read. Forwarding browser credentials
  // would make the shared response unsafe and can force a Workers Cache bypass.
  return new Request(url, {
    method: "GET",
    headers: { accept: "application/json" },
  });
}

export async function servePublicDiffPair(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  input: PublicDiffPairInput,
  options: { workersCache?: boolean } = {},
): Promise<Response> {
  try {
    const payload = await loadPublicPackageDiff(env, ctx, input);
    return publicDiffPairResponse(payload, options.workersCache ?? false);
  } catch (err) {
    if (err instanceof PublicDiffError) {
      return errorResponse(err.message, err.status);
    }
    throw err;
  }
}

function publicDiffPairResponse(payload: PublicPackageDiff, workersCache: boolean): Response {
  const headers = new Headers({
    "cache-control": BROWSER_CACHE_CONTROL,
    "cache-tag": publicDiffCacheTag(payload.packageName),
  });
  if (workersCache) {
    // Cloudflare consumes this header at the named entrypoint. Browsers retain
    // the stricter Cache-Control policy above and revalidate after deployments.
    headers.set("cloudflare-cdn-cache-control", EDGE_CACHE_CONTROL);
  }

  return Response.json(
    {
      packageName: payload.packageName,
      fromVersion: payload.fromVersion,
      toVersion: payload.toVersion,
      fromPackageJson: payload.fromPackageJson,
      toPackageJson: payload.toPackageJson,
      diff: payload.diff,
      packageJsonDiff: payload.packageJsonDiff,
      findings: payload.findings,
      risk: payload.risk,
      textSamplesOmitted: payload.textSamplesOmitted ?? false,
      cachedAt: payload.cachedAt,
    },
    { status: 200, headers },
  );
}

function errorResponse(message: string, status: number): Response {
  return Response.json(
    { error: message },
    {
      status,
      headers: { "cache-control": NO_STORE },
    },
  );
}

export function publicDiffCacheTag(packageName: string): string {
  return `public-diff:${packageName}`;
}

// Only this named entrypoint is opted into Workers Cache. The default export,
// static assets, /versions, and /file remain outside the cache tier.
export class PublicDiffReads extends WorkerEntrypoint<Cloudflare.Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== PUBLIC_DIFF_PATH) {
      return errorResponse("not found", 404);
    }

    const configuredRegistry = (this.env.NPM_REGISTRY || PUBLIC_NPM_REGISTRY).replace(/\/+$/, "");
    if (configuredRegistry !== PUBLIC_NPM_REGISTRY) {
      return errorResponse("public package diff is disabled for custom registries", 404);
    }

    const parsed = parsePublicDiffPairInput(url.searchParams);
    if ("error" in parsed) return errorResponse(parsed.error, parsed.status);
    return servePublicDiffPair(this.env, this.ctx, parsed.input, { workersCache: true });
  }
}
