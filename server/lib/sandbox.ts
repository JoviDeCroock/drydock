import { WorkerEntrypoint } from "cloudflare:workers";
import type { FileRecord, PackageJsonSummary } from "./review";
import { STAGE_ID_PATTERN } from "./stage-id";
import * as tarParser from "./tar-parser.js";
import type { TarSuspiciousEntry } from "./tar-parser.js";

export const SANDBOX_MAX_FILES = 2_500;
// Hard cap on archive entries walked at all. SANDBOX_MAX_FILES bounds the
// expensive tier (bodies retained with a full text sample for detection);
// entries past that tier are still hashed and native-sniffed but recorded
// hash-only, so per-entry cost is header parsing plus digest work already
// bounded by the stream-byte budget below. Sized for big-but-honest sdists —
// numpy vendors its whole build system (8k+ files) — while staying under the
// zip EOCD 16-bit entry count.
export const SANDBOX_MAX_ENTRIES = 20_000;
const SANDBOX_MAX_TAR_BYTES = 25 * 1024 * 1024;
// Total decompressed bytes the streaming tar reader may consume. Bodies beyond
// the retention budget (SANDBOX_MAX_TAR_BYTES) are skipped, not buffered, so
// this cap bounds CPU/streaming work rather than memory — it is what lets big
// prepackaged-binary packages dock without buffering their binaries.
export const SANDBOX_MAX_STREAM_TAR_BYTES = 10 * SANDBOX_MAX_TAR_BYTES;
const MAX_FILES = SANDBOX_MAX_FILES;
const MAX_ENTRIES = SANDBOX_MAX_ENTRIES;
const MAX_TAR_BYTES = SANDBOX_MAX_TAR_BYTES;
const MAX_STREAM_TAR_BYTES = SANDBOX_MAX_STREAM_TAR_BYTES;

// Functions whose source text is concatenated into the sandbox worker module.
// They must remain referenced only by lexical name (no closures) so the order
// of concatenation and the names below stay stable after bundling.
const SANDBOX_TAR_PARSER_EXPORTS = [
  tarParser.readString,
  tarParser.decodeText,
  tarParser.isPlainObject,
  tarParser.normalizeStringRecord,
  tarParser.normalizePeerDependenciesMeta,
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
  tarParser.createSha256Digester,
  tarParser.createStreamCursor,
  tarParser.shouldSkipTextSample,
  tarParser.sniffNativeArtifact,
  tarParser.createHeadCapture,
  tarParser.summarizeFile,
  tarParser.summarizeSkippedFile,
  tarParser.isRetainedManifestPath,
  tarParser.isRootManifestPath,
  tarParser.tarError,
  tarParser.readTarStream,
  tarParser.readUint16Le,
  tarParser.readUint32Le,
  tarParser.boundedByteStream,
  tarParser.pumpDeflatedZipEntry,
  tarParser.digestSkippedZipEntry,
  tarParser.inflateRetainedZipEntry,
  tarParser.readZipStream,
  tarParser.findZipEndOfCentralDirectory,
  tarParser.inflateRawBounded,
  tarParser.readStreamBounded,
  tarParser.readZipArchiveBuffered,
  tarParser.parsePackageJson,
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
  kind: "staged-tarball" | "package-metadata" | "public-artifact" | "blocked";
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
  const isRegistryMetadata = sameOrigin && normalizedMethod === "GET" && packageMetadataPath;

  if (isPublicArtifact) return { allowed: true, credentialed: false, kind: "public-artifact" };
  if (isStagedTarball) return { allowed: true, credentialed: true, kind: "staged-tarball" };
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
  archiveFormat?: "tgz" | "zip" | "vsix";
  publicArtifactUrls?: string[];
  maxFiles?: number;
  npmToken?: string;
  npmRegistry?: string;
}

export class SandboxError extends Error {
  constructor(public detail: string) {
    super("sandbox download failed");
    this.name = "SandboxError";
  }
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

/**
 * Parse a sandbox error's serialized `{ error, status }` detail. Returns null
 * when the error is not a sandbox error or its detail is not the expected shape,
 * so callers can branch on the sandbox's own status/error without each
 * re-implementing the JSON.parse dance.
 */
export function parseSandboxErrorDetail(
  err: unknown,
): { error: string | null; status: number | null } | null {
  const detailText = sandboxErrorDetail(err);
  if (detailText === null) return null;
  try {
    const parsed = JSON.parse(detailText) as { error?: unknown; status?: unknown };
    return {
      error: typeof parsed.error === "string" ? parsed.error : null,
      status: typeof parsed.status === "number" ? parsed.status : null,
    };
  } catch {
    return null;
  }
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

export interface InlineDownloadOptions {
  bytes: Uint8Array;
  format: "tgz" | "zip" | "vsix";
  maxFiles?: number;
}

export interface StreamDownloadOptions {
  body: ReadableStream<Uint8Array>;
  format: "tgz" | "zip" | "vsix";
  maxFiles?: number;
}

/**
 * Inline-bytes sandbox entrypoint. The control plane passes a pre-downloaded
 * archive directly as the POST body; the sandbox parses it with the same tar/
 * zip readers it uses for npm tarballs, but no outbound fetch is issued.
 *
 * This is the credentials-free counterpart of `downloadInSandbox` — the gateway
 * is constructed with empty props so even an internally compromised sandbox
 * could not exfiltrate an npm token (there isn't one in scope). It exists for
 * the PyPI workflow-gate path, where GitHub installation tokens stay in the
 * parent worker and the wheel/sdist bytes are the only thing that crosses the
 * trust boundary.
 */
export async function downloadInSandboxInline(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  options: InlineDownloadOptions,
): Promise<DownloadResult> {
  if (!options.bytes || options.bytes.byteLength === 0) {
    throw new SandboxError(JSON.stringify({ error: "inline archive body is empty", status: 400 }));
  }
  // Parse-side sanity cap only: the sandbox streams both formats now, so the
  // bound is total streaming work, not what fits in the sandbox heap.
  if (options.bytes.byteLength > MAX_STREAM_TAR_BYTES) {
    throw new SandboxError(JSON.stringify({ error: "archive too large", status: 413 }));
  }
  const body = new ArrayBuffer(options.bytes.byteLength);
  new Uint8Array(body).set(options.bytes);
  return parseInCredentialsFreeSandbox(env, ctx, body, options.format, options.maxFiles);
}

/**
 * Streaming variant of {@link downloadInSandboxInline}: the caller pipes a
 * (still hostile, already policy-checked) archive body straight through to
 * the sandbox without the parent worker ever buffering it. Used for the
 * previous-published-version diff baseline, whose token-credentialed fetch
 * must stay in the trusted parent while its bytes must not occupy parent
 * memory.
 */
export async function downloadInSandboxStream(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  options: StreamDownloadOptions,
): Promise<DownloadResult> {
  return parseInCredentialsFreeSandbox(env, ctx, options.body, options.format, options.maxFiles);
}

async function parseInCredentialsFreeSandbox(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  body: ArrayBuffer | ReadableStream<Uint8Array>,
  format: "tgz" | "zip" | "vsix",
  maxFiles?: number,
): Promise<DownloadResult> {
  const sandbox = env.LOADER.load({
    compatibilityDate: "2026-05-20",
    mainModule: "sandbox.js",
    modules: { "sandbox.js": sandboxSource() },
    env: {
      NPM_REGISTRY: env.NPM_REGISTRY || "https://registry.npmjs.org",
      ARCHIVE_FORMAT: format,
      MAX_FILES: Math.min(maxFiles ?? MAX_FILES, MAX_FILES),
      MAX_ENTRIES,
      MAX_TAR_BYTES,
      MAX_STREAM_TAR_BYTES,
    },
    globalOutbound: (
      ctx as unknown as {
        exports: { NpmStageGateway(options: { props: NpmStageGatewayProps }): Fetcher };
      }
    ).exports.NpmStageGateway({ props: {} }),
    limits: { cpuMs: 2_000, subRequests: 0 },
  });

  const response = await sandbox.getEntrypoint().fetch(
    new Request("https://sandbox.local/download", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/octet-stream",
        "x-archive-format": format,
      },
      // Fetch-spec streaming uploads require half duplex; workerd streams
      // same-process request bodies either way, so this is a no-op there.
      duplex: "half",
    } as RequestInit),
  );

  if (!response.ok) {
    throw new SandboxError(await response.text());
  }
  return (await response.json()) as DownloadResult;
}

export async function downloadInSandbox(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  options: DownloadOptions,
): Promise<DownloadResult> {
  if (options.tarballUrl) {
    // The only credentialed sandbox egress is the staged-tarball endpoint
    // (fetched via stageId). A direct tarballUrl is reserved for pinned,
    // uncredentialed public artifacts (e.g. PyPI files.pythonhosted.org);
    // npm previous-version tarballs are fetched by the trusted parent worker.
    try {
      const tarball = new URL(options.tarballUrl);
      const isPublicArtifact =
        tarball.protocol === "https:" &&
        (options.publicArtifactUrls ?? []).some((allowedUrl) => allowedUrl === options.tarballUrl);
      if (!isPublicArtifact) {
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
      MAX_ENTRIES,
      MAX_TAR_BYTES,
      MAX_STREAM_TAR_BYTES,
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
    const inlineFormat = request.headers.get("x-archive-format");
    const maxTarBytes = env.MAX_TAR_BYTES || 26214400;
    const archiveFormat = inlineFormat || env.ARCHIVE_FORMAT || "tgz";
    let res;
    if (inlineFormat) {
      if (archiveFormat !== "zip" && archiveFormat !== "tgz" && archiveFormat !== "vsix") return json({ error: "invalid inline archive format", status: 400 }, 400);
      res = new Response(request.body, { status: 200, headers: { "content-type": "application/octet-stream" } });
    } else {
      const { stageId, tarballUrl } = await request.json();
      if (!tarballUrl && !STAGE_ID_RE.test(stageId)) return json({ error: "invalid stageId" }, 400);

      const registry = env.NPM_REGISTRY || "https://registry.npmjs.org";
      const url = tarballUrl || registry.replace(/\\/$/, "") + "/-/stage/" + encodeURIComponent(stageId) + "/tarball";
      res = await fetch(url, { headers: { accept: "application/octet-stream" } });
      if (!res.ok) return json({ error: "download failed", status: res.status }, 502);

      // Only the vsix path buffers the whole archive, so only it needs the
      // wire-size gate; tgz and wheel zips stream.
      const contentLength = Number(res.headers.get("content-length") || "0");
      if (archiveFormat === "vsix" && contentLength > maxTarBytes) return json({ error: "tarball too large", status: 413 }, 413);
    }
    const maxStreamTarBytes = env.MAX_STREAM_TAR_BYTES || maxTarBytes * 10;
    if (archiveFormat === "vsix") {
      // VSIX zips are packed by yazl (via vsce), whose streamed entries carry
      // their sizes in data descriptors — only the central directory (what
      // consumers read) is authoritative, so the archive buffers under the
      // wire cap and is parsed CD-first, exactly as before zip streaming.
      let zip;
      try {
        zip = await readStreamBounded(res.body, maxTarBytes);
      } catch (err) {
        const reason = err && err.message === "archive too large" ? "archive too large" : "archive download failed";
        const status = reason === "archive too large" ? 413 : 400;
        return json({ error: reason, status }, status);
      }
      let files;
      let suspiciousEntries;
      try {
        const parsed = await readZipArchiveBuffered(
          zip,
          env.MAX_FILES || 2_500,
          maxTarBytes,
          env.MAX_ENTRIES || env.MAX_FILES || 2_500,
        );
        files = parsed.files;
        suspiciousEntries = parsed.suspicious;
      } catch (err) {
        const reason = err && err.tarSafety && err.message ? err.message : "zip parse failed";
        const status = reason === "archive contains too many files" || reason === "archive expands beyond safety limit" ? 413 : 400;
        return json({ error: reason, status }, status);
      }
      return json({ files, packageJson: null, suspiciousEntries });
    }
    if (archiveFormat === "zip") {
      let files;
      let suspiciousEntries;
      try {
        if (!res.body) return json({ error: "archive download failed", status: 400 }, 400);
        const parsed = await readZipStream(res.body, env.MAX_FILES || 2_500, maxTarBytes, maxStreamTarBytes, env.MAX_ENTRIES || env.MAX_FILES || 2_500);
        files = parsed.files;
        suspiciousEntries = parsed.suspicious;
      } catch (err) {
        // The parser tags its own safety-limit / malformed-archive errors, so
        // anything untagged is an upstream stream failure. This avoids
        // matching on exact message text, which silently drifts on a reword.
        const reason = err && err.tarSafety && err.message ? err.message : "zip parse failed";
        const status = reason === "archive contains too many files" || reason === "archive expands beyond safety limit" ? 413 : 400;
        return json({ error: reason, status }, status);
      }
      return json({ files, packageJson: null, suspiciousEntries });
    }

    let files;
    let suspiciousEntries;
    try {
      if (!res.body) return json({ error: "tarball decompression failed", status: 400 }, 400);
      // Cap the compressed wire bytes too: gzip can decode a huge input to
      // almost nothing, so the decompressed budget inside readTarStream does
      // not bound download size or inflater CPU on its own.
      const tarStream = boundedByteStream(res.body, maxStreamTarBytes).pipeThrough(new DecompressionStream("gzip"));
      const parsed = await readTarStream(tarStream, env.MAX_FILES || 2_500, maxTarBytes, maxStreamTarBytes, env.MAX_ENTRIES || env.MAX_FILES || 2_500);
      files = parsed.files;
      suspiciousEntries = parsed.suspicious;
    } catch (err) {
      // The parser tags its own safety-limit / malformed-archive errors, so
      // anything untagged is an upstream gzip/stream failure. This avoids
      // matching on exact message text, which silently drifts on a reword.
      const reason = err && err.tarSafety && err.message ? err.message : "tarball decompression failed";
      const status = reason === "archive contains too many files" || reason === "archive expands beyond safety limit" ? 413 : 400;
      return json({ error: reason, status }, status);
    }
    const packageJson = parsePackageJson(files);
    return json({ files, packageJson, suspiciousEntries });
  },
};

function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8" } }); }
`;
}
