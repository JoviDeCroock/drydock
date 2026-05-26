import { WorkerEntrypoint } from "cloudflare:workers";
import { allowInsecureLocalRegistry, registryProtocolAllowed } from "./npm-connection";
import type { FileRecord, PackageJsonSummary } from "./review";
import { STAGE_ID_PATTERN } from "./stage-id";
import * as tarParser from "./tar-parser.js";
import type { TarSuspiciousEntry } from "./tar-parser.js";

const MAX_FILES = 250;
const MAX_BYTES_PER_FILE = 64 * 1024;
const MAX_TAR_BYTES = 25 * 1024 * 1024;
const STAGE_ID_RE = new RegExp(`^${STAGE_ID_PATTERN}$`);

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
  allowedUrl: string;
  credentialed?: boolean;
}

export interface NpmStageGatewayDecision {
  allowed: boolean;
}

export function matchAllowedRequest(
  requestUrl: string,
  method: string,
  allowedUrl: string,
  options: { allowInsecureLocalhost?: boolean } = {},
): NpmStageGatewayDecision {
  if (method.toUpperCase() !== "GET") return { allowed: false };
  let request: URL;
  let allowed: URL;
  try {
    request = new URL(requestUrl);
    allowed = new URL(allowedUrl);
  } catch {
    return { allowed: false };
  }
  if (!registryProtocolAllowed(request, options) || !registryProtocolAllowed(allowed, options)) {
    return { allowed: false };
  }
  if (request.origin !== allowed.origin) return { allowed: false };
  if (request.pathname !== allowed.pathname) return { allowed: false };
  if (request.search !== allowed.search) return { allowed: false };
  return { allowed: true };
}

export function isAllowedPublishedTarballUrl(
  tarballUrl: string,
  registryUrl: string,
  options: { allowInsecureLocalhost?: boolean } = {},
): boolean {
  try {
    const tarball = new URL(tarballUrl);
    const registry = new URL(registryUrl);
    return (
      tarball.origin === registry.origin &&
      registryProtocolAllowed(tarball, options) &&
      tarball.pathname.endsWith(".tgz") &&
      tarball.pathname.includes("/-/")
    );
  } catch {
    return false;
  }
}

export function isAllowedPublicArtifactUrl(
  artifactUrl: string,
  publicArtifactUrls: readonly string[] = [],
): boolean {
  try {
    const artifact = new URL(artifactUrl);
    if (artifact.protocol !== "https:") return false;
    return publicArtifactUrls.some((allowedUrl) => {
      try {
        return new URL(allowedUrl).toString() === artifact.toString();
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export class NpmStageGateway extends WorkerEntrypoint<Cloudflare.Env, NpmStageGatewayProps> {
  async fetch(request: Request): Promise<Response> {
    const decision = matchAllowedRequest(request.url, request.method, this.ctx.props.allowedUrl, {
      allowInsecureLocalhost: allowInsecureLocalRegistry(this.env),
    });
    if (!decision.allowed) {
      return new Response("blocked by stage gateway", { status: 403 });
    }

    const token = this.ctx.props.npmToken;
    const forwarded = new Request(request, { redirect: "manual" });
    if (token && this.ctx.props.credentialed !== false) {
      forwarded.headers.set("authorization", `Bearer ${token}`);
    }
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
  const target = resolveTargetUrl(registry, options, {
    allowInsecureLocalhost: allowInsecureLocalRegistry(env),
  });
  const sandbox = env.LOADER.load({
    compatibilityDate: "2026-05-20",
    compatibilityFlags: [],
    mainModule: "sandbox.js",
    modules: { "sandbox.js": sandboxSource() },
    env: {
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
        allowedUrl: target.url,
        credentialed: target.credentialed,
      },
    }),
    limits: { cpuMs: 2_000, subRequests: 1 },
  });

  const response = await sandbox.getEntrypoint().fetch(
    new Request("https://sandbox.local/download", {
      method: "POST",
      body: JSON.stringify({ targetUrl: target.url }),
      headers: { "content-type": "application/json" },
    }),
  );

  if (!response.ok) {
    throw new SandboxError(await response.text());
  }
  return (await response.json()) as DownloadResult;
}

function resolveTargetUrl(
  registry: string,
  options: DownloadOptions,
  protocolOptions: { allowInsecureLocalhost?: boolean },
): { url: string; credentialed: boolean } {
  if (options.tarballUrl) {
    if (isAllowedPublishedTarballUrl(options.tarballUrl, registry, protocolOptions)) {
      return { url: new URL(options.tarballUrl).toString(), credentialed: true };
    }
    if (isAllowedPublicArtifactUrl(options.tarballUrl, options.publicArtifactUrls)) {
      return { url: new URL(options.tarballUrl).toString(), credentialed: false };
    }
    throw new SandboxError(
      JSON.stringify({ error: "tarball URL is not allowed by the gateway", status: 400 }),
    );
  }
  if (!options.stageId || !STAGE_ID_RE.test(options.stageId)) {
    throw new SandboxError(JSON.stringify({ error: "invalid stageId", status: 400 }));
  }
  let registryUrl: URL;
  try {
    registryUrl = new URL(registry);
  } catch {
    throw new SandboxError(JSON.stringify({ error: "invalid registry URL", status: 400 }));
  }
  if (!registryProtocolAllowed(registryUrl, protocolOptions)) {
    throw new SandboxError(
      JSON.stringify({ error: "registry URL is not allowed by the gateway", status: 400 }),
    );
  }
  return {
    url: `${registry.replace(/\/$/, "")}/-/stage/${encodeURIComponent(options.stageId)}/tarball`,
    credentialed: true,
  };
}

function sandboxSource() {
  return `// Lock down ambient capabilities the parser doesn't need so a parser
// regression cannot reach them. caches would let untrusted bytes be cached
// across scans; the sandbox never needs it.
try {
  Object.defineProperty(globalThis, "caches", { value: undefined, configurable: true });
} catch {}

${renderTarParserSource()}

export default {
  async fetch(request, env) {
    const { targetUrl } = await request.json();
    if (typeof targetUrl !== "string" || !targetUrl) {
      return json({ error: "missing targetUrl", status: 400 }, 400);
    }

    const res = await fetch(targetUrl, { headers: { accept: "application/octet-stream" } });
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
