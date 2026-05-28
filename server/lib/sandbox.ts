import { WorkerEntrypoint } from "cloudflare:workers";
import { allowInsecureLocalRegistry, registryProtocolAllowed } from "./npm-connection";
import type { FileRecord, PackageJsonSummary } from "./review";
import { STAGE_ID_PATTERN } from "./stage-id";
import * as tarParser from "./tar-parser.js";
import type { TarSuspiciousEntry } from "./tar-parser.js";

const MAX_FILES = 250;
const MAX_BYTES_PER_FILE = 64 * 1024;
const MAX_TAR_BYTES = 25 * 1024 * 1024;

// Functions whose source text is concatenated into the sandbox worker module.
// They must remain referenced only by lexical name (no closures) so the order
// of concatenation and the names below stay stable after bundling.
const SANDBOX_TAR_PARSER_EXPORTS = [
  tarParser.readString,
  tarParser.decodeText,
  tarParser.isPlainObject,
  tarParser.normalizeStringRecord,
  tarParser.normalizeStringList,
  tarParser.canonicalizePath,
  tarParser.hasUnicodeConfusables,
  tarParser.isRootGypPath,
  tarParser.hasImplicitNodeGypInstall,
  tarParser.isSafePaxPath,
  tarParser.normalizeTarPath,
  tarParser.normalizeZipPath,
  tarParser.parsePax,
  tarParser.describeNonRegularType,
  tarParser.sha256Hex,
  tarParser.summarizeFile,
  tarParser.readTar,
  tarParser.readUint16Le,
  tarParser.readUint32Le,
  tarParser.findZipEndOfCentralDirectory,
  tarParser.inflateRawBounded,
  tarParser.readZipArchive,
  tarParser.readStreamBounded,
  tarParser.parsePackageJson,
  tarParser.gunzipBounded,
];

function renderTarParserSource() {
  return SANDBOX_TAR_PARSER_EXPORTS.map((fn) => fn.toString()).join("\n\n");
}

interface NpmStageGatewayProps {
  npmToken?: string;
  npmRegistry?: string;
  publicArtifactUrls?: string[];
}

export interface NpmStageGatewayPolicy {
  allowed: boolean;
  credentialed: boolean;
  kind: "staged-tarball" | "published-tarball" | "package-metadata" | "public-artifact" | "blocked";
}

export function evaluateNpmStageGatewayRequest(
  requestUrl: string,
  method: string,
  registryUrl: string,
  publicArtifactUrls: string[] = [],
): NpmStageGatewayPolicy {
  const url = new URL(requestUrl);
  const registry = new URL(registryUrl || "https://registry.npmjs.org");
  const sameOrigin = url.origin === registry.origin;
  const normalizedMethod = method.toUpperCase();
  const isPublicArtifact =
    normalizedMethod === "GET" &&
    url.protocol === "https:" &&
    publicArtifactUrls.some((allowedUrl) => requestUrl === allowedUrl);
  const packageMetadataPath = /^\/(?:@[^/]+%2[fF][^/]+|[^/@-][^/]*)$/.test(url.pathname);
  const isStagedTarball =
    sameOrigin &&
    normalizedMethod === "GET" &&
    url.pathname.startsWith("/-/stage/") &&
    url.pathname.endsWith("/tarball");
  const isPublishedTarball =
    sameOrigin &&
    normalizedMethod === "GET" &&
    url.pathname.endsWith(".tgz") &&
    url.pathname.includes("/-/");
  const isRegistryMetadata = sameOrigin && normalizedMethod === "GET" && packageMetadataPath;

  if (isPublicArtifact) return { allowed: true, credentialed: false, kind: "public-artifact" };
  if (isStagedTarball) return { allowed: true, credentialed: true, kind: "staged-tarball" };
  if (isPublishedTarball) return { allowed: true, credentialed: true, kind: "published-tarball" };
  if (isRegistryMetadata) return { allowed: true, credentialed: true, kind: "package-metadata" };
  return { allowed: false, credentialed: false, kind: "blocked" };
}

export class NpmStageGateway extends WorkerEntrypoint<Cloudflare.Env, NpmStageGatewayProps> {
  async fetch(request: Request): Promise<Response> {
    const registry =
      this.ctx.props.npmRegistry || this.env.NPM_REGISTRY || "https://registry.npmjs.org";
    const policy = evaluateNpmStageGatewayRequest(
      request.url,
      request.method,
      registry,
      this.ctx.props.publicArtifactUrls,
    );

    if (!policy.allowed) {
      return new Response("blocked by stage gateway", { status: 403 });
    }

    const token = this.ctx.props.npmToken;
    const forwarded = new Request(request);
    if (token && policy.credentialed) forwarded.headers.set("authorization", `Bearer ${token}`);
    forwarded.headers.set("user-agent", "staged-publish-review/0.3");

    return fetch(forwarded);
  }
}

export interface DownloadResult {
  files: FileRecord[];
  packageJson?: PackageJsonSummary | null;
  suspiciousEntries?: TarSuspiciousEntry[];
}

export interface DownloadOptions {
  stageId?: string;
  tarballUrl?: string;
  archiveFormat?: "tgz" | "zip";
  publicArtifactUrls?: string[];
  maxFiles?: number;
  maxBytesPerFile?: number;
  npmToken?: string;
  npmRegistry?: string;
}

export class SandboxError extends Error {
  constructor(public detail: string) {
    super("sandbox download failed");
    this.name = "SandboxError";
  }
}

export function isSandboxError(err: unknown): boolean {
  return sandboxErrorDetail(err) !== null;
}

export function sandboxErrorDetail(err: unknown): string | null {
  if (err instanceof SandboxError) return err.detail;
  if (!err || typeof err !== "object") return null;
  const value = err as Record<string, unknown>;
  if (value.name !== "SandboxError") return null;
  if (typeof value.detail === "string") return value.detail;
  if (typeof value.message === "string" && isSerializedSandboxDetail(value.message)) {
    return value.message;
  }
  return null;
}

function isSerializedSandboxDetail(message: string): boolean {
  if (!message.trim().startsWith("{")) return false;
  try {
    const parsed = JSON.parse(message) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const value = parsed as Record<string, unknown>;
    return typeof value.error === "string" || typeof value.status === "number";
  } catch {
    return false;
  }
}

export async function downloadInSandbox(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  options: DownloadOptions,
): Promise<DownloadResult> {
  const registry = options.npmRegistry || env.NPM_REGISTRY || "https://registry.npmjs.org";
  if (options.tarballUrl) {
    try {
      const tarball = new URL(options.tarballUrl);
      const registryOrigin = new URL(registry).origin;
      const isRegistryArtifact =
        tarball.origin === registryOrigin &&
        registryProtocolAllowed(tarball, {
          allowInsecureLocalhost: allowInsecureLocalRegistry(env),
        });
      const isPublicArtifact =
        tarball.protocol === "https:" &&
        (options.publicArtifactUrls ?? []).some((allowedUrl) => allowedUrl === options.tarballUrl);
      if (!isRegistryArtifact && !isPublicArtifact) {
        throw new SandboxError(
          JSON.stringify({ error: "tarball URL is not allowed by the gateway", status: 400 }),
        );
      }
    } catch (err) {
      if (err instanceof SandboxError) throw err;
      throw new SandboxError(JSON.stringify({ error: "invalid tarball URL", status: 400 }));
    }
  }
  const sandbox = env.LOADER.load({
    compatibilityDate: "2026-05-20",
    mainModule: "sandbox.js",
    modules: { "sandbox.js": sandboxSource() },
    env: {
      NPM_REGISTRY: options.npmRegistry || env.NPM_REGISTRY || "https://registry.npmjs.org",
      ARCHIVE_FORMAT: options.archiveFormat || "tgz",
      MAX_FILES: Math.min(options.maxFiles ?? MAX_FILES, MAX_FILES),
      MAX_BYTES_PER_FILE: Math.min(
        options.maxBytesPerFile ?? MAX_BYTES_PER_FILE,
        MAX_BYTES_PER_FILE,
      ),
      MAX_TAR_BYTES,
    },
    globalOutbound: (
      ctx as unknown as {
        exports: { NpmStageGateway(options: { props: NpmStageGatewayProps }): Fetcher };
      }
    ).exports.NpmStageGateway({
      props: {
        npmToken: options.npmToken,
        npmRegistry: options.npmRegistry,
        publicArtifactUrls: options.publicArtifactUrls,
      },
    }),
    limits: { cpuMs: 2_000, subRequests: 4 },
  });

  const response = await sandbox.getEntrypoint().fetch(
    new Request("https://sandbox.local/download", {
      method: "POST",
      body: JSON.stringify({ stageId: options.stageId, tarballUrl: options.tarballUrl }),
      headers: { "content-type": "application/json" },
    }),
  );

  if (!response.ok) {
    throw new SandboxError(await response.text());
  }
  return (await response.json()) as DownloadResult;
}

function sandboxSource() {
  return `${renderTarParserSource()}

const STAGE_ID_RE = new RegExp(${JSON.stringify(`^${STAGE_ID_PATTERN}$`)});

export default {
  async fetch(request, env) {
    const { stageId, tarballUrl } = await request.json();
    if (!tarballUrl && !STAGE_ID_RE.test(stageId)) return json({ error: "invalid stageId" }, 400);

    const registry = env.NPM_REGISTRY || "https://registry.npmjs.org";
    const url = tarballUrl || registry.replace(/\\/$/, "") + "/-/stage/" + encodeURIComponent(stageId) + "/tarball";
    const res = await fetch(url, { headers: { accept: "application/octet-stream" } });
    if (!res.ok) return json({ error: "download failed", status: res.status }, 502);

    const maxTarBytes = env.MAX_TAR_BYTES || 26214400;
    const contentLength = Number(res.headers.get("content-length") || "0");
    if (contentLength > maxTarBytes) return json({ error: "tarball too large", status: 413 }, 413);
    const archiveFormat = env.ARCHIVE_FORMAT || "tgz";
    if (archiveFormat === "zip") {
      let zip;
      try {
        zip = await readStreamBounded(res.body, maxTarBytes);
      } catch (err) {
        const reason = err && err.message === "archive too large" ? "archive too large" : "archive download failed";
        const status = reason === "archive too large" ? 413 : 400;
        return json({ error: reason, status }, status);
      }
      let files;
      try {
        files = await readZipArchive(zip, env.MAX_FILES || 250, env.MAX_BYTES_PER_FILE || 65536, maxTarBytes);
      } catch (err) {
        const reason = err && err.message === "archive contains too many files"
          ? "archive contains too many files"
          : err && err.message === "archive expands beyond safety limit"
            ? "archive expands beyond safety limit"
            : err && err.message
              ? err.message
              : "zip parse failed";
        const status = reason === "archive contains too many files" || reason === "archive expands beyond safety limit" ? 413 : 400;
        return json({ error: reason, status }, status);
      }
      return json({ files, packageJson: null });
    }

    let tar;
    try {
      tar = await gunzipBounded(res.body, maxTarBytes);
    } catch (err) {
      const reason = err && err.message === "archive expands beyond safety limit"
        ? "archive expands beyond safety limit"
        : "tarball decompression failed";
      const status = reason === "archive expands beyond safety limit" ? 413 : 400;
      return json({ error: reason, status }, status);
    }
    if (tar.byteLength > maxTarBytes) return json({ error: "archive expands beyond safety limit", status: 413 }, 413);
    let files;
    let suspiciousEntries;
    try {
      const parsed = await readTar(tar, env.MAX_FILES || 250, env.MAX_BYTES_PER_FILE || 65536, maxTarBytes);
      files = parsed.files;
      suspiciousEntries = parsed.suspicious;
    } catch (err) {
      const reason = err && err.message === "archive contains too many files"
        ? "archive contains too many files"
        : err && err.message
          ? err.message
          : "tarball parse failed";
      const status = reason === "archive contains too many files" ? 413 : 400;
      return json({ error: reason, status }, status);
    }
    const packageJson = parsePackageJson(files);
    return json({ files, packageJson, suspiciousEntries });
  },
};

function json(value, status = 200) { return new Response(JSON.stringify(value, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } }); }
`;
}
