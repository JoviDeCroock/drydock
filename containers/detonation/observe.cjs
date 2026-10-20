// Node preload (`NODE_OPTIONS=--require`) for detonation steps. It runs inside
// the package's own process as the package user, so everything it records is
// tamperable: the harness keeps only its DNS events when strace is attached and
// uses the rest only as a fallback. It must never change package behavior, so
// every hook calls through unconditionally and swallows its own errors.
"use strict";

const logPath = process.env.DRYDOCK_HOOK_LOG;

if (logPath) {
  try {
    install(logPath);
  } catch {
    // Observation is best effort; a failed install must not break the package.
  }
}

function install(file) {
  const fs = require("node:fs");
  const childProcess = require("node:child_process");
  const net = require("node:net");
  const dns = require("node:dns");
  const { syncBuiltinESMExports } = require("node:module");
  const { posix } = require("node:path");
  // Captured so a package replacing process.cwd cannot steer where its relative
  // paths appear to point.
  const processCwd = process.cwd;

  // Captured before any wrapping so logging never re-enters a hook.
  const appendFileSync = fs.appendFileSync;
  const pid = process.pid;
  let depth = 0;

  // appendFileSync calls the public (wrapped) writeFileSync internally, so the
  // depth guard must cover logging too or every write would log itself.
  function emit(event) {
    depth += 1;
    try {
      appendFileSync(file, `${JSON.stringify({ ...event, pid })}\n`);
    } catch {
      // The log is root-provisioned; a full disk or a removed file is not our problem to surface.
    } finally {
      depth -= 1;
    }
  }

  function describePath(value) {
    if (typeof value === "string") return absolute(value, null);
    if (value instanceof URL)
      return value.protocol === "file:" ? absolute(value.pathname, null) : null;
    if (Buffer.isBuffer(value)) return absolute(value.toString("utf8"), null);
    return null;
  }

  // The parent matches evidence by absolute path, so `.npmrc` read after
  // `process.chdir(os.homedir())` must read as `/home/pkg/.npmrc`.
  function absolute(value, base) {
    let resolved = value;
    if (!resolved.startsWith("/")) {
      let cwd;
      try {
        cwd = posix.resolve(Reflect.apply(processCwd, process, []), base ?? ".");
      } catch {
        // A deleted cwd makes process.cwd() throw; report the path as given.
        return resolved;
      }
      resolved = posix.join(cwd, resolved);
    }
    resolved = posix.normalize(resolved);
    return resolved.length > 1 && resolved.endsWith("/") ? resolved.slice(0, -1) : resolved;
  }

  // Nested public calls (exec -> execFile -> spawn, createReadStream -> open)
  // would otherwise log one action several times.
  function wrap(target, name, record) {
    const original = target[name];
    if (typeof original !== "function") return;
    const wrapped = function (...args) {
      if (depth === 0) {
        try {
          const event = record(args);
          if (event) emit(event);
        } catch {
          // Never let a malformed argument surface as an observer error.
        }
      }
      depth += 1;
      try {
        return Reflect.apply(original, this, args);
      } finally {
        depth -= 1;
      }
    };
    try {
      Object.defineProperty(wrapped, "name", { value: original.name });
      Object.defineProperty(wrapped, "length", { value: original.length });
      target[name] = wrapped;
    } catch {
      // Frozen or non-writable export: leave it unobserved.
    }
  }

  function fileEvent(op, value) {
    const path = describePath(value);
    return path === null ? null : { kind: "file", op, path };
  }

  function openOp(flags) {
    if (typeof flags === "number") {
      if (flags & fs.constants.O_CREAT) return "create";
      if (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) return "write";
      return "read";
    }
    if (typeof flags !== "string") return "read";
    if (/[wa]/.test(flags)) return "create";
    if (flags.includes("+")) return "write";
    return "read";
  }

  function flagOf(options, fallback) {
    if (typeof options === "string") return fallback;
    return options && typeof options === "object" && options.flag !== undefined
      ? options.flag
      : fallback;
  }

  wrap(fs, "openSync", (args) => fileEvent(openOp(args[1] ?? "r"), args[0]));
  wrap(fs, "open", (args) =>
    fileEvent(openOp(typeof args[1] === "function" ? "r" : (args[1] ?? "r")), args[0]),
  );
  wrap(fs, "readFileSync", (args) => fileEvent(openOp(flagOf(args[1], "r")), args[0]));
  wrap(fs, "readFile", (args) => fileEvent(openOp(flagOf(args[1], "r")), args[0]));
  wrap(fs, "createReadStream", (args) => fileEvent("read", args[0]));
  wrap(fs, "writeFileSync", (args) => fileEvent("create", args[0]));
  wrap(fs, "writeFile", (args) => fileEvent("create", args[0]));
  wrap(fs, "appendFileSync", (args) => fileEvent("create", args[0]));
  wrap(fs, "appendFile", (args) => fileEvent("create", args[0]));
  wrap(fs, "createWriteStream", (args) => fileEvent("create", args[0]));
  wrap(fs, "unlinkSync", (args) => fileEvent("delete", args[0]));
  wrap(fs, "unlink", (args) => fileEvent("delete", args[0]));
  wrap(fs, "rmSync", (args) => fileEvent("delete", args[0]));
  wrap(fs, "rm", (args) => fileEvent("delete", args[0]));
  wrap(fs, "renameSync", (args) => fileEvent("rename", args[1]));
  wrap(fs, "rename", (args) => fileEvent("rename", args[1]));
  wrap(fs, "chmodSync", (args) => fileEvent("chmod", args[0]));
  wrap(fs, "chmod", (args) => fileEvent("chmod", args[0]));
  const promises = fs.promises;
  wrap(promises, "open", (args) => fileEvent(openOp(args[1] ?? "r"), args[0]));
  wrap(promises, "readFile", (args) => fileEvent(openOp(flagOf(args[1], "r")), args[0]));
  wrap(promises, "writeFile", (args) => fileEvent("create", args[0]));
  wrap(promises, "appendFile", (args) => fileEvent("create", args[0]));
  wrap(promises, "unlink", (args) => fileEvent("delete", args[0]));
  wrap(promises, "rm", (args) => fileEvent("delete", args[0]));
  wrap(promises, "rename", (args) => fileEvent("rename", args[1]));
  wrap(promises, "chmod", (args) => fileEvent("chmod", args[0]));

  function execEvent(file, rest, options) {
    if (typeof file !== "string") return null;
    const argv = [file];
    if (Array.isArray(rest)) for (const arg of rest) argv.push(String(arg));
    // A bare name is a PATH search; anything with a slash is relative to the
    // spawn's cwd option, or ours.
    const base =
      options && typeof options === "object" && typeof options.cwd === "string"
        ? options.cwd
        : null;
    return { kind: "exec", path: file.includes("/") ? absolute(file, base) : file, argv };
  }
  function spawnOptions(args) {
    return Array.isArray(args[1]) ? args[2] : args[1];
  }
  function shellEvent(command) {
    if (typeof command !== "string") return null;
    return { kind: "exec", path: "/bin/sh", argv: ["/bin/sh", "-c", command] };
  }

  wrap(childProcess, "spawn", (args) => execEvent(args[0], args[1], spawnOptions(args)));
  wrap(childProcess, "spawnSync", (args) => execEvent(args[0], args[1], spawnOptions(args)));
  wrap(childProcess, "execFile", (args) => execEvent(args[0], args[1], spawnOptions(args)));
  wrap(childProcess, "execFileSync", (args) => execEvent(args[0], args[1], spawnOptions(args)));
  wrap(childProcess, "exec", (args) => shellEvent(args[0]));
  wrap(childProcess, "execSync", (args) => shellEvent(args[0]));
  wrap(childProcess, "fork", (args) =>
    execEvent(process.execPath, [String(args[0]), ...(Array.isArray(args[1]) ? args[1] : [])]),
  );

  function connectEvents(args) {
    let options = args[0];
    if (Array.isArray(options)) options = options[0];
    let host;
    let port = null;
    let path;
    if (options && typeof options === "object") {
      host = options.host;
      port = options.port ?? null;
      path = options.path;
    } else if (typeof options === "number" || /^\d+$/.test(String(options))) {
      port = options;
      host = typeof args[1] === "string" ? args[1] : "localhost";
    } else if (typeof options === "string") {
      path = options;
    }
    if (typeof path === "string") {
      const address = path.startsWith("\0") || path === "" ? path : absolute(path, null);
      return [{ kind: "connect", family: "unix", address, port: null }];
    }
    const hostname = typeof host === "string" ? host : "localhost";
    const portNumber = Number(port);
    const family = net.isIP(hostname);
    if (family === 0) return [{ kind: "dns", hostname }];
    return [
      {
        kind: "connect",
        family: family === 6 ? "inet6" : "inet",
        address: hostname,
        port: Number.isInteger(portNumber) ? portNumber : null,
      },
    ];
  }

  function wrapMulti(target, name, record) {
    wrap(target, name, (args) => {
      const events = record(args);
      for (const event of events.slice(1)) emit(event);
      return events[0] ?? null;
    });
  }

  wrapMulti(net.Socket.prototype, "connect", connectEvents);
  wrapMulti(net, "connect", connectEvents);
  wrapMulti(net, "createConnection", connectEvents);

  function dnsEvent(args) {
    return typeof args[0] === "string" ? { kind: "dns", hostname: args[0] } : null;
  }
  for (const name of [
    "lookup",
    "resolve",
    "resolve4",
    "resolve6",
    "resolveAny",
    "resolveCname",
    "resolveMx",
    "resolveNs",
    "resolveTxt",
    "resolveSrv",
  ]) {
    wrap(dns, name, dnsEvent);
    wrap(dns.promises, name, dnsEvent);
  }

  // ESM named imports of builtins (`import { readFileSync } from "node:fs"`)
  // are snapshots until synced.
  syncBuiltinESMExports();
  emit({ kind: "loaded" });
}
