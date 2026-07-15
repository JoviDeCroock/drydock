import http from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { x as extractTar } from "tar";
import { detonateLocal } from "./harness.mjs";

// HTTP entrypoint for the detonation container. This is what runs inside a
// Cloudflare Container (or any container host): the Worker never executes
// package code — it POSTs the reviewed file bytes here and receives a behavior
// report. The container is the sacrificial environment; its own boundary
// (no network, read-only rootfs, dropped caps — see the run flags in
// buildDockerArgs / the deployment) is the real containment.
//
// Contract:
//   GET  /health           -> { ok: true }
//   POST /detonate         -> exact, identity-checked npm .tgz bytes
//                             returns a drydock.detonation.v1 report
//
// The request carries package file bytes ONLY. It must never receive registry
// credentials, tokens, or org identifiers — detonation runs credential-free.
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 2500;
const MAX_EXTRACTED_BYTES = 250 * 1024 * 1024;

export function createDetonationServer() {
  return http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, { ok: true });
    }
    if (req.method !== "POST" || req.url !== "/detonate") {
      return json(res, 404, { error: "not found" });
    }

    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        json(res, 413, { error: "package too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      void handleDetonate(Buffer.concat(chunks), res);
    });
  });
}

async function handleDetonate(archive, res) {
  if (archive.length === 0) return json(res, 400, { error: "package archive is required" });
  const root = await mkdtemp(path.join(os.tmpdir(), "detonation-input-"));
  try {
    const archivePath = path.join(root, "package.tgz");
    const packageDir = path.join(root, "package");
    await mkdir(packageDir);
    await writeFile(archivePath, archive);
    let fileCount = 0;
    let extractedBytes = 0;
    await extractTar({
      cwd: packageDir,
      file: archivePath,
      gzip: true,
      preserveOwner: false,
      strict: true,
      strip: 1,
      filter(entryPath, entry) {
        if (!isSafePackagePath(entryPath)) throw new Error("unsafe package archive path");
        if (!new Set(["File", "OldFile", "ContiguousFile", "Directory"]).has(entry.type)) {
          throw new Error("unsupported package archive entry");
        }
        if (entry.type !== "Directory") {
          fileCount += 1;
          extractedBytes += entry.size;
          if (fileCount > MAX_FILES || extractedBytes > MAX_EXTRACTED_BYTES) {
            throw new Error("package archive exceeds extraction limits");
          }
        }
        return true;
      },
    });
    const report = await detonateLocal({ packageDir });
    return json(res, 200, report);
  } catch (err) {
    return json(res, 500, { error: "detonation failed", detail: String(err?.message || err) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function isSafePackagePath(entryPath) {
  if (typeof entryPath !== "string" || !entryPath.startsWith("package/")) return false;
  if (entryPath.includes("\\") || entryPath.includes("\0")) return false;
  const relative = entryPath.slice("package/".length);
  return relative.length > 0 && relative.split("/").every((part) => part && part !== "." && part !== "..");
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

// Entrypoint when run directly (the container CMD).
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 8080;
  createDetonationServer().listen(port, "0.0.0.0", () => {
    process.stdout.write(`detonation service listening on :${port}\n`);
  });
}
