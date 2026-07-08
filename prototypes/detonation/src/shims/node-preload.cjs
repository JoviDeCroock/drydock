"use strict";

// Instrumentation preloaded into every Node process the detonation runs
// (via NODE_OPTIONS=--require). It records behavior to an append-only JSONL
// log and, in local mode, blocks real network egress so a payload cannot phone
// home during a demo. All hooks are wrapped so instrumentation can never crash
// the target — a payload must not be able to evade us by making us throw.
//
// Captured references to the real implementations are taken BEFORE patching so
// our own bookkeeping (writing the log) never re-enters a patched function.

const realFs = require("node:fs");
const realPath = require("node:path");
const net = require("node:net");
const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");

const LOG_PATH = process.env.DETONATION_LOG;
const WORK_ROOT = process.env.DETONATION_WORK_ROOT || process.cwd();
const CANARY_PATHS = safeParse(process.env.DETONATION_CANARY_PATHS) || [];
const CANARY_TOKENS = safeParse(process.env.DETONATION_CANARY_TOKENS) || [];
const BLOCK_NON_LOOPBACK = process.env.DETONATION_BLOCK_EGRESS !== "0";

const appendFileSync = realFs.appendFileSync.bind(realFs);
const resolvePath = realPath.resolve.bind(realPath);

function safeParse(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function record(event) {
  if (!LOG_PATH) return;
  try {
    appendFileSync(LOG_PATH, `${JSON.stringify({ ...event, pid: process.pid })}\n`);
  } catch {
    // Instrumentation must never break the target.
  }
}

function scanForCanary(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  for (const token of CANARY_TOKENS) {
    if (token && value.includes(token)) return token;
  }
  return null;
}

function isLoopback(host) {
  // net.connect with no host defaults to localhost, so treat an empty host as
  // loopback rather than misreporting it as external egress.
  if (!host) return true;
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost")
  );
}

function isCanaryPath(target) {
  let resolved;
  try {
    resolved = resolvePath(target);
  } catch {
    return null;
  }
  return CANARY_PATHS.find((canary) => resolved === canary) || null;
}

// Canonicalize through symlinks so the work-root comparison is stable. On
// macOS the OS temp dir is /var/... (a symlink to /private/var/...), and a
// module's __dirname resolves to the /private form while env-derived paths keep
// the /var form — without canonicalizing, in-workdir writes look "outside".
// realpathSync only works on existing paths, so canonicalize the deepest
// existing ancestor and re-append the non-existent tail (the file being written).
function canonicalize(target) {
  let current = resolvePath(target);
  const tail = [];
  for (;;) {
    try {
      const real = realFs.realpathSync(current);
      return tail.length ? `${real}/${tail.reverse().join("/")}` : real;
    } catch {
      const parent = realPath.dirname(current);
      if (parent === current) return resolvePath(target);
      tail.push(realPath.basename(current));
      current = parent;
    }
  }
}

function isOutsideWorkRoot(target) {
  let resolved;
  try {
    resolved = canonicalize(target);
  } catch {
    return false;
  }
  const root = canonicalize(WORK_ROOT);
  if (resolved === root || resolved.startsWith(`${root}/`)) return false;
  return resolved;
}

// ---- child_process -------------------------------------------------------
const childProcess = require("node:child_process");
for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  const original = childProcess[method];
  if (typeof original !== "function") continue;
  childProcess[method] = function instrumented(command, ...rest) {
    const args = Array.isArray(rest[0]) ? rest[0] : [];
    record({ type: "process.spawn", method, command: String(command), args: args.map(String) });
    const canary = scanForCanary([command, ...args].join(" "));
    if (canary) record({ type: "credential.exfil", via: `process:${method}`, token: canary });
    return original.apply(this, [command, ...rest]);
  };
}

// ---- fs reads (canary access) and writes (out-of-workdir persistence) -----
for (const method of ["readFileSync", "readFile", "openSync", "createReadStream"]) {
  const original = realFs[method];
  if (typeof original !== "function") continue;
  realFs[method] = function instrumented(target, ...rest) {
    const canary = typeof target === "string" ? isCanaryPath(target) : null;
    if (canary) record({ type: "credential.read", path: canary, via: `fs:${method}` });
    return original.apply(this, [target, ...rest]);
  };
}
// Our own log lives outside the work root; never flag writes to it. (Node's
// appendFileSync delegates to writeFileSync internally, so record()'s own
// appends would otherwise trip this hook — and recurse.)
const LOG_REAL = LOG_PATH ? resolvePath(LOG_PATH) : null;
for (const method of ["writeFileSync", "writeFile", "appendFileSync", "appendFile", "createWriteStream"]) {
  const original = realFs[method];
  if (typeof original !== "function") continue;
  realFs[method] = function instrumented(target, ...rest) {
    if (typeof target === "string" && (!LOG_REAL || resolvePath(target) !== LOG_REAL)) {
      const outside = isOutsideWorkRoot(target);
      if (outside) record({ type: "fs.write.outside", path: outside, via: `fs:${method}` });
    }
    return original.apply(this, [target, ...rest]);
  };
}

// ---- dns -----------------------------------------------------------------
const originalLookup = dns.lookup;
dns.lookup = function instrumented(hostname, ...rest) {
  record({ type: "dns.lookup", host: String(hostname) });
  return originalLookup.apply(this, [hostname, ...rest]);
};

// ---- net (egress + block) ------------------------------------------------
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function instrumented(...args) {
  const options = args[0];
  let host;
  let port;
  if (options && typeof options === "object") {
    host = options.host;
    port = options.port;
  } else {
    port = args[0];
    host = typeof args[1] === "string" ? args[1] : "localhost";
  }
  const loopback = isLoopback(host);
  record({ type: "net.connect", host: String(host ?? ""), port: Number(port) || null, loopback });
  if (!loopback && BLOCK_NON_LOOPBACK) {
    record({ type: "net.egress.blocked", host: String(host ?? ""), port: Number(port) || null });
    // Fail closed: surface a connection error instead of reaching the network.
    process.nextTick(() => this.destroy(new Error("detonation: egress blocked")));
    return this;
  }
  return originalConnect.apply(this, args);
};

// ---- http/https (destination + body canary scan) -------------------------
for (const mod of [http, https]) {
  const originalRequest = mod.request;
  mod.request = function instrumented(...args) {
    const info = describeRequest(args);
    record({ type: "http.request", protocol: mod === https ? "https" : "http", ...info });
    const req = originalRequest.apply(this, args);
    const originalWrite = req.write.bind(req);
    const originalEnd = req.end.bind(req);
    const scanChunk = (chunk) => {
      if (!chunk) return;
      const canary = scanForCanary(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      if (canary) record({ type: "credential.exfil", via: "http.body", token: canary, ...info });
    };
    req.write = (chunk, ...rest) => {
      scanChunk(chunk);
      return originalWrite(chunk, ...rest);
    };
    req.end = (chunk, ...rest) => {
      if (chunk && typeof chunk !== "function") scanChunk(chunk);
      return originalEnd(chunk, ...rest);
    };
    return req;
  };
  const originalGet = mod.get;
  mod.get = function instrumented(...args) {
    const req = mod.request(...args);
    req.end();
    return req;
  };
  void originalGet;
}

function describeRequest(args) {
  const first = args[0];
  if (typeof first === "string") {
    try {
      const url = new URL(first);
      return { host: url.hostname, path: url.pathname, method: "GET" };
    } catch {
      return { host: first, path: "", method: "GET" };
    }
  }
  if (first && typeof first === "object") {
    return {
      host: String(first.hostname || first.host || ""),
      path: String(first.path || "/"),
      method: String(first.method || "GET"),
    };
  }
  return { host: "", path: "", method: "GET" };
}

record({ type: "process.start", argv: process.argv.slice(1).map(String) });
