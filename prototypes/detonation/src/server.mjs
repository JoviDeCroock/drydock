import http from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
//   POST /detonate         -> body { package: { name, version, files: {path: contents} } }
//                             returns a drydock.detonation.v1 report
//
// The request carries package file bytes ONLY. It must never receive registry
// credentials, tokens, or org identifiers — detonation runs credential-free.
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 5000;

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
      void handleDetonate(Buffer.concat(chunks).toString("utf8"), res);
    });
  });
}

async function handleDetonate(rawBody, res) {
  let input;
  try {
    input = JSON.parse(rawBody);
  } catch {
    return json(res, 400, { error: "invalid JSON body" });
  }
  const pkg = input && typeof input === "object" ? input.package : null;
  const files = pkg && typeof pkg === "object" ? pkg.files : null;
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    return json(res, 400, { error: "package.files map is required" });
  }
  const entries = Object.entries(files).filter(
    ([, contents]) => typeof contents === "string",
  );
  if (entries.length === 0 || entries.length > MAX_FILES) {
    return json(res, 400, { error: "package.files must have 1..5000 string entries" });
  }
  if (!entries.some(([relPath]) => relPath === "package.json")) {
    return json(res, 400, { error: "package.files must include package.json" });
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "detonation-input-"));
  try {
    for (const [relPath, contents] of entries) {
      if (!isSafeRelPath(relPath)) continue; // never let a path escape the input dir
      const absolute = path.join(root, relPath);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, contents);
    }
    const report = await detonateLocal({ packageDir: root });
    return json(res, 200, report);
  } catch (err) {
    return json(res, 500, { error: "detonation failed", detail: String(err?.message || err) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Reject absolute paths and any `..` traversal so a hostile file map cannot
// write outside the extraction dir.
function isSafeRelPath(relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) return false;
  if (path.isAbsolute(relPath)) return false;
  const normalized = path.normalize(relPath);
  return !normalized.startsWith("..") && !normalized.includes(`..${path.sep}`);
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
