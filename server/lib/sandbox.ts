import { WorkerEntrypoint } from "cloudflare:workers";
import type { FileRecord, PackageJsonSummary } from "./review";

const MAX_FILES = 250;
const MAX_BYTES_PER_FILE = 64 * 1024;
const MAX_TAR_BYTES = 25 * 1024 * 1024;

interface NpmStageGatewayProps {
  npmToken?: string;
  npmRegistry?: string;
}

export interface NpmStageGatewayPolicy {
  allowed: boolean;
  credentialed: boolean;
  kind: "staged-tarball" | "published-tarball" | "package-metadata" | "blocked";
}

export function evaluateNpmStageGatewayRequest(
  requestUrl: string,
  method: string,
  registryUrl: string,
): NpmStageGatewayPolicy {
  const url = new URL(requestUrl);
  const registry = new URL(registryUrl || "https://registry.npmjs.org");
  const sameOrigin = url.origin === registry.origin;
  const normalizedMethod = method.toUpperCase();
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

  if (isStagedTarball) return { allowed: true, credentialed: true, kind: "staged-tarball" };
  if (isPublishedTarball) return { allowed: true, credentialed: true, kind: "published-tarball" };
  if (isRegistryMetadata) return { allowed: true, credentialed: true, kind: "package-metadata" };
  return { allowed: false, credentialed: false, kind: "blocked" };
}

export class NpmStageGateway extends WorkerEntrypoint<Cloudflare.Env, NpmStageGatewayProps> {
  async fetch(request: Request): Promise<Response> {
    const registry =
      this.ctx.props.npmRegistry || this.env.NPM_REGISTRY || "https://registry.npmjs.org";
    const policy = evaluateNpmStageGatewayRequest(request.url, request.method, registry);

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
}

export interface DownloadOptions {
  stageId?: string;
  tarballUrl?: string;
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

export async function downloadInSandbox(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  options: DownloadOptions,
): Promise<DownloadResult> {
  const sandbox = env.LOADER.load({
    compatibilityDate: "2026-05-20",
    mainModule: "sandbox.js",
    modules: { "sandbox.js": sandboxSource() },
    env: {
      NPM_REGISTRY: options.npmRegistry || env.NPM_REGISTRY || "https://registry.npmjs.org",
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
      props: { npmToken: options.npmToken, npmRegistry: options.npmRegistry },
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
  return String.raw`
const STAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,160}$/;

export default {
  async fetch(request, env) {
    const { stageId, tarballUrl } = await request.json();
    if (!tarballUrl && !STAGE_ID_RE.test(stageId)) return json({ error: "invalid stageId" }, 400);

    const registry = env.NPM_REGISTRY || "https://registry.npmjs.org";
    const url = tarballUrl || registry.replace(/\/$/, "") + "/-/stage/" + encodeURIComponent(stageId) + "/tarball";
    const res = await fetch(url, { headers: { accept: "application/octet-stream" } });
    if (!res.ok) return json({ error: "download failed", status: res.status }, 502);

    const contentLength = Number(res.headers.get("content-length") || "0");
    if (contentLength > (env.MAX_TAR_BYTES || 26214400)) return json({ error: "tarball too large", status: 413 }, 413);
    const gzip = await res.arrayBuffer();
    const tar = await gunzip(gzip);
    if (tar.byteLength > (env.MAX_TAR_BYTES || 26214400)) return json({ error: "archive expands beyond safety limit", status: 413 }, 413);
    const files = await readTar(tar, env.MAX_FILES || 250, env.MAX_BYTES_PER_FILE || 65536);
    const packageJson = parsePackageJson(files);
    return json({ files, packageJson });
  },
};

async function gunzip(buffer) {
  const ds = new DecompressionStream("gzip");
  const stream = new Response(buffer).body.pipeThrough(ds);
  return await new Response(stream).arrayBuffer();
}

async function readTar(buffer, maxFiles, maxBytesPerFile) {
  const bytes = new Uint8Array(buffer);
  const files = [];
  let nextLongName = null;
  let pax = null;

  for (let offset = 0; offset + 512 <= bytes.length && files.length < maxFiles;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;

    const rawName = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const sizeText = readString(header, 124, 12).trim() || "0";
    if (!/^[0-7]+$/.test(sizeText)) throw new Error("invalid tar entry size");
    const size = parseInt(sizeText, 8);
    const type = String.fromCharCode(header[156] || 48);
    offset += 512;
    if (offset + size > bytes.length) throw new Error("truncated tar entry");
    const body = bytes.subarray(offset, offset + size);

    if (type === "x") {
      pax = parsePax(body);
    } else if (type === "L") {
      nextLongName = readString(body, 0, body.length).replace(/\0+$/, "");
    } else if (type === "0" || type === "\0") {
      const path = normalizeTarPath(pax?.path || nextLongName || (prefix ? prefix + "/" : "") + rawName);
      if (path) files.push(await summarizeFile(path, body, maxBytesPerFile));
      nextLongName = null;
      pax = null;
    } else if (type === "1" || type === "2") {
      // Hardlinks and symlinks are not extracted. They are skipped so link targets cannot escape the package tree.
      nextLongName = null;
      pax = null;
    } else if (type !== "L") {
      nextLongName = null;
      pax = null;
    }

    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

async function summarizeFile(path, body, maxBytesPerFile) {
  const flags = [];
  if (body.length > maxBytesPerFile) flags.push("truncated");
  const sample = body.subarray(0, Math.min(body.length, maxBytesPerFile));
  const text = decodeText(sample);
  if (!text) flags.push("binary");
  return { path, size: body.length, sha256: await sha256(body), flags, ...(text ? { textSample: text } : {}) };
}

function normalizeTarPath(rawPath) {
  if (!rawPath || rawPath.includes("\0") || rawPath.includes("\\")) return null;
  let path = rawPath.replace(/^\/+/, "").replace(/^package\//, "");
  if (!path || path.startsWith("../") || path.includes("/../") || /^[A-Za-z]:/.test(path)) return null;
  const parts = path.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) return null;
  path = parts.join("/");
  if (path.length > 512) return null;
  return path;
}

function parsePax(body) {
  const text = decodeText(body.subarray(0, Math.min(body.length, 8192)));
  const out = {};
  let index = 0;
  while (index < text.length) {
    const space = text.indexOf(" ", index);
    if (space === -1) break;
    const length = Number(text.slice(index, space));
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, index + length).replace(/\n$/, "");
    const equals = record.indexOf("=");
    if (equals > 0) out[record.slice(0, equals)] = record.slice(equals + 1);
    index += length;
  }
  return out;
}

function parsePackageJson(files) {
  const pkg = files.find((f) => f.path === "package.json" && f.textSample);
  if (!pkg) return null;
  try {
    const parsed = JSON.parse(pkg.textSample);
    return {
      name: parsed.name,
      version: parsed.version,
      scripts: parsed.scripts || {},
      dependencies: parsed.dependencies || {},
      devDependencies: parsed.devDependencies || {},
      peerDependencies: parsed.peerDependencies || {},
      optionalDependencies: parsed.optionalDependencies || {},
      bin: parsed.bin,
      main: parsed.main,
      module: parsed.module,
      types: parsed.types,
      exports: parsed.exports,
    };
  } catch { return null; }
}

function readString(bytes, start, len) { let out = ""; for (let i = start; i < start + len && bytes[i]; i++) out += String.fromCharCode(bytes[i]); return out; }
function decodeText(bytes) { if (bytes.some((b) => b === 0)) return ""; const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes); const control = [...text].filter((ch) => ch < " " && !"\n\r\t".includes(ch)).length; if (control > Math.max(5, text.length * 0.02)) return ""; return text; }
async function sha256(bytes) { const digest = await crypto.subtle.digest("SHA-256", bytes); return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""); }
function json(value, status = 200) { return new Response(JSON.stringify(value, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } }); }
`;
}
