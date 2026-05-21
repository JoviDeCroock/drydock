import { WorkerEntrypoint } from "cloudflare:workers";
import type { FileRecord, PackageJsonSummary } from "./review";

const MAX_FILES = 250;
const MAX_BYTES_PER_FILE = 64 * 1024;

export class NpmStageGateway extends WorkerEntrypoint<Cloudflare.Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const registry = new URL(this.env.NPM_REGISTRY || "https://registry.npmjs.org");

    const sameOrigin = url.origin === registry.origin;
    const isStagedTarball =
      sameOrigin && url.pathname.startsWith("/-/stage/") && url.pathname.endsWith("/tarball");
    const isPublishedTarball =
      sameOrigin && url.pathname.endsWith(".tgz") && url.pathname.includes("/-/");
    const isRegistryMetadata =
      sameOrigin &&
      !url.pathname.includes("/-/stage/") &&
      request.headers.get("accept")?.includes("application/json");

    if (!isStagedTarball && !isPublishedTarball && !isRegistryMetadata) {
      return new Response("blocked by stage gateway", { status: 403 });
    }

    const token = this.env.NPM_TOKEN;
    const forwarded = new Request(request);
    if (token && isStagedTarball) forwarded.headers.set("authorization", `Bearer ${token}`);
    forwarded.headers.set("user-agent", "staged-publish-sandbox-prototype/0.2");

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
      NPM_REGISTRY: env.NPM_REGISTRY || "https://registry.npmjs.org",
      MAX_FILES: Math.min(options.maxFiles ?? MAX_FILES, MAX_FILES),
      MAX_BYTES_PER_FILE: Math.min(options.maxBytesPerFile ?? MAX_BYTES_PER_FILE, MAX_BYTES_PER_FILE),
    },
    globalOutbound: (ctx as unknown as { exports: { NpmStageGateway(): Fetcher } }).exports.NpmStageGateway(),
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
    if (!res.ok) return json({ error: "download failed", status: res.status, body: await res.text() }, 502);

    const gzip = await res.arrayBuffer();
    const tar = await gunzip(gzip);
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
  for (let offset = 0; offset + 512 <= bytes.length && files.length < maxFiles;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const path = (prefix ? prefix + "/" : "") + name;
    const size = parseInt(readString(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    offset += 512;
    const body = bytes.subarray(offset, offset + size);
    if (type === "0" || type === "\0") files.push(await summarizeFile(path, body, maxBytesPerFile));
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
  return { path: path.replace(/^package\//, ""), size: body.length, sha256: await sha256(body), flags, ...(text ? { textSample: text } : {}) };
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
