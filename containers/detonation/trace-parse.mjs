// Pure strace-line parser for the detonation harness. No I/O: the harness owns
// reading the root-only trace file and the test suite feeds captured lines.
//
// Input is `strace -f -y -o <file> -s 256` output, so every line starts with the
// pid and fd arguments carry the kernel's view of their path (`3</home/pkg>`,
// `AT_FDCWD</work/app>`). Lines are produced by the package's own syscalls,
// which means string arguments are attacker-chosen bytes; strace escapes them,
// and this module decodes them without ever evaluating anything.
//
// Every reported path is absolute and normalized when the parser can know the
// directory it was relative to, because the parent matches evidence by
// absolute path: `cd ~ && cat .npmrc` must read as `/home/pkg/.npmrc`.
import { posix } from "node:path";

/** @typedef {import("../../server/lib/detonation/types.ts").HarnessEvent} HarnessEvent */
/** @typedef {import("../../server/lib/detonation/types.ts").DetonationStep} DetonationStep */

const MAX_ARGV_ITEMS = 16;
const MAX_ARG_CHARS = 256;
/** Joined argv bound, so one exec event cannot cost the report 16 full arguments. */
const MAX_ARGV_CHARS = 2048;
const MAX_PATH_CHARS = 512;
/** Lines held for pids whose parent's clone has not been seen yet. */
const MAX_DEFERRED_LINES = 20_000;

/** Written by the harness for its own runtime-hook logs; never package behavior. */
export const HOOK_LOG_DIR = "/work/.drydock-hooks";

/** Shown in place of an argument strace could not read from tracee memory. */
const UNREADABLE = "[unreadable]";

const LINE_RE = /^(\d+)\s+(.*)$/;
const CALL_RE = /^([a-z0-9_]+)\(/;
const RESULT_RE = /^\s*=\s*(-?\d+|0x[0-9a-f]+|\?)/;
const ERRNO_RE = /^\s+([A-Z][A-Z0-9_]*)/;
const UNFINISHED_RE = /\s*<unfinished \.\.\.>\s*$/;

const HOME_PREFIXES = ["/home/pkg/", "/root/"];
const CLONE_CALLS = new Set(["clone", "clone3", "fork", "vfork"]);
/** Calls whose first argument is a dirfd that `-y` annotates. */
const AT_CALLS = new Set(["openat", "unlinkat", "renameat", "renameat2", "fchmodat", "execveat"]);

/**
 * @typedef {{ failed: boolean, errno: string | null, value: number | null, fdPath: string | null }} CallResult
 * @typedef {{ pid: number, name: string, args: string[], result: CallResult | null }} ParsedCall
 */

/**
 * Parses one line in isolation. Relative paths resolve against `cwd` when it
 * is given; `createTraceReader` tracks it per process for a whole trace.
 *
 * @param {string} line
 * @param {DetonationStep} step
 * @param {string} target
 * @param {string | null} [cwd]
 * @returns {HarnessEvent | null}
 */
export function parseStraceLine(line, step, target, cwd = null) {
  const call = parseCall(line);
  return call === null ? null : callEvent(call, step, target, cwd, false);
}

/**
 * Stateful reader for one step's trace. It re-joins interleaved halves, skips
 * the harness's own launch, keeps each process's working directory (inherited
 * across fork/clone, shared by `CLONE_FS` threads, moved by chdir/fchdir), and
 * reports PATH searches that never found their command.
 *
 * The first pid is the root `setpriv`; its lines up to and including its
 * second successful execve (setpriv itself, then the step command) are the
 * harness's own launch, not package behavior.
 *
 * @param {{ step: DetonationStep, target: string, cwd: string }} options
 */
export function createTraceReader({ step, target, cwd }) {
  const joiner = createLineJoiner();
  /** Shared by reference between processes created with CLONE_FS. @type {Map<number, { cwd: string | null }>} */
  const fsState = new Map();
  /** @type {Map<number, string[]>} */
  const deferred = new Map();
  let deferredCount = 0;
  /** @type {number | null} */
  let rootPid = null;
  let rootExecs = 0;
  /** @type {Map<number, HarnessEvent>} */
  const missingExecs = new Map();
  // `strace -f` labels each line with the thread id, and Node does its file
  // I/O on libuv pool threads, so events carry the thread group (process) id
  // that the parent attributes behavior to.
  /** @type {Map<number, number>} */
  const tgids = new Map();

  /** @param {string} line @param {HarnessEvent[]} out */
  const handle = (line, out) => {
    const pidMatch = LINE_RE.exec(line);
    if (!pidMatch) return;
    const pid = Number(pidMatch[1]);
    if (rootPid === null) {
      rootPid = pid;
      fsState.set(pid, { cwd });
    }
    let state = fsState.get(pid);
    if (state === undefined) {
      // A child can print before its parent's clone returns; hold its lines
      // until the clone says who the parent was.
      if (deferredCount < MAX_DEFERRED_LINES) {
        const queue = deferred.get(pid) ?? [];
        queue.push(line);
        deferred.set(pid, queue);
        deferredCount += 1;
        return;
      }
      state = { cwd: null };
      fsState.set(pid, state);
    }

    const parsed = parseCall(line);
    if (parsed === null) return;
    const tgid = tgids.get(pid) ?? pid;
    const call = tgid === pid ? parsed : { ...parsed, pid: tgid };
    trackCwd(call, state);
    if (CLONE_CALLS.has(call.name) && call.result !== null && !call.result.failed) {
      const child = call.result.value;
      if (child !== null && child > 0 && !fsState.has(child)) {
        const sharesFs = call.args.some((arg) => /\bCLONE_FS\b/.test(arg));
        fsState.set(child, sharesFs ? state : { cwd: state.cwd });
        tgids.set(child, call.args.some((arg) => /\bCLONE_THREAD\b/.test(arg)) ? tgid : child);
        const queued = deferred.get(child);
        if (queued !== undefined) {
          deferred.delete(child);
          deferredCount -= queued.length;
          for (const queuedLine of queued) handle(queuedLine, out);
        }
      }
    }

    if (pid === rootPid && rootExecs < 2) {
      if (call.name === "execve" && call.result !== null && call.result.value === 0) rootExecs += 1;
      return;
    }
    const isExec = call.name === "execve" || call.name === "execveat";
    if (isExec && call.result?.failed && call.result.errno === "ENOENT") {
      const missing = callEvent(call, step, target, state.cwd, true);
      if (missing !== null) missingExecs.set(pid, missing);
      return;
    }
    const event = callEvent(call, step, target, state.cwd, false);
    if (event === null) return;
    if (event.kind === "exec") missingExecs.delete(pid);
    out.push(event);
  };

  return {
    /** @param {string} line @returns {HarnessEvent[]} */
    push(line) {
      /** @type {HarnessEvent[]} */
      const out = [];
      for (const joined of joiner.push(line)) handle(joined, out);
      return out;
    },
    /** @returns {HarnessEvent[]} */
    flush() {
      /** @type {HarnessEvent[]} */
      const out = [];
      for (const joined of joiner.flush()) handle(joined, out);
      // Parents never seen (the trace was cut): the directory is unknown.
      for (const [pid, queued] of deferred) {
        fsState.set(pid, { cwd: null });
        for (const queuedLine of queued) handle(queuedLine, out);
      }
      deferred.clear();
      deferredCount = 0;
      // A PATH search that never found its command is still an exec attempt.
      out.push(...missingExecs.values());
      missingExecs.clear();
      return out;
    },
  };
}

/** @param {ParsedCall} call @param {{ cwd: string | null }} state */
function trackCwd(call, state) {
  const { name, args, result } = call;
  // The kernel's own cwd, printed by `-y`, corrects any drift in the tracking.
  if (AT_CALLS.has(name)) {
    const dirfd = args[0];
    if (dirfd?.startsWith("AT_FDCWD<")) {
      const actual = fdPath(dirfd);
      if (actual !== null) state.cwd = actual;
    }
  }
  if (result === null || result.failed) return;
  if (name === "chdir") {
    const target = decodeString(args[0]);
    if (target !== null) {
      const next = normalizePath(target, state.cwd);
      state.cwd = next.startsWith("/") ? next : null;
    }
  } else if (name === "fchdir") {
    state.cwd = fdPath(args[0]);
  }
}

/**
 * @param {string} line
 * @returns {ParsedCall | null}
 */
function parseCall(line) {
  const lineMatch = LINE_RE.exec(line);
  if (!lineMatch) return null;
  const pid = Number(lineMatch[1]);
  let body = lineMatch[2];
  // `<... openat resumed>` carries only the tail of the arguments; the
  // `<unfinished ...>` half already had the path, so the resumed half is skipped.
  if (body.startsWith("<...") || body.startsWith("---") || body.startsWith("+++")) return null;

  let unfinished = false;
  if (UNFINISHED_RE.test(body)) {
    unfinished = true;
    body = body.replace(UNFINISHED_RE, "");
  }

  const callMatch = CALL_RE.exec(body);
  if (!callMatch) return null;
  const name = callMatch[1];
  const scanned = scanArgs(body, callMatch[0].length, unfinished);
  if (!scanned) return null;
  const { args, rest } = scanned;
  if (unfinished) return { pid, name, args, result: null };

  const resultMatch = RESULT_RE.exec(rest);
  if (!resultMatch) return null;
  const tail = rest.slice(resultMatch[0].length);
  const raw = resultMatch[1];
  const value = /^-?\d+$/.test(raw) ? Number(raw) : null;
  let fdAnnotation = null;
  if (tail.startsWith("<")) fdAnnotation = decodeQuoted(tail, 0, ">")?.value ?? null;
  return {
    pid,
    name,
    args,
    result: {
      failed: raw === "-1",
      errno: ERRNO_RE.exec(tail)?.[1] ?? null,
      value,
      fdPath: fdAnnotation !== null && fdAnnotation.startsWith("/") ? fdAnnotation : null,
    },
  };
}

/**
 * @param {ParsedCall} call
 * @param {DetonationStep} step
 * @param {string} target
 * @param {string | null} cwd
 * @param {boolean} keepMissingExec
 * @returns {HarnessEvent | null}
 */
function callEvent(call, step, target, cwd, keepMissingExec) {
  const { pid, name, args } = call;
  const result = call.result ?? { failed: false, errno: null, value: null, fdPath: null };
  const base = { step, target, pid, via: /** @type {const} */ ("syscall") };

  switch (name) {
    case "execve":
    case "execveat": {
      // PATH lookups probe every directory; only the hit is behavior. The
      // reader reports commands that were never found.
      if (result.failed && result.errno === "ENOENT" && !keepMissingExec) return null;
      let path;
      if (name === "execve") {
        path = pathArg(args[0], cwd);
      } else {
        const dir = dirBase(args[0], cwd);
        // fexecve(): an empty path with AT_EMPTY_PATH runs the dirfd itself.
        path =
          decodeString(args[1]) === "" ? (fdPath(args[0]) ?? `[fd ${fdNumber(args[0])}]`) : null;
        path ??= pathArg(args[1], dir);
      }
      const argvArg = name === "execve" ? args[1] : args[2];
      return boundEvent({ ...base, kind: "exec", path, argv: arrayArg(argvArg) });
    }
    case "open":
    case "creat":
    case "openat": {
      const lexical =
        name === "openat" ? pathArg(args[1], dirBase(args[0], cwd)) : pathArg(args[0], cwd);
      if (dropFailure(result, lexical)) return null;
      const op = name === "creat" ? "create" : openOp(name === "openat" ? args[2] : args[1]);
      return boundEvent({ ...base, kind: "file", op, path: openedPath(lexical, result.fdPath) });
    }
    case "unlink":
    case "unlinkat": {
      const path =
        name === "unlink" ? pathArg(args[0], cwd) : pathArg(args[1], dirBase(args[0], cwd));
      if (dropFailure(result, path)) return null;
      return boundEvent({ ...base, kind: "file", op: "delete", path });
    }
    case "rename":
    case "renameat":
    case "renameat2": {
      const path =
        name === "rename" ? pathArg(args[1], cwd) : pathArg(args[3], dirBase(args[2], cwd));
      if (dropFailure(result, path)) return null;
      return boundEvent({ ...base, kind: "file", op: "rename", path });
    }
    case "chmod":
    case "fchmodat": {
      const path =
        name === "chmod" ? pathArg(args[0], cwd) : pathArg(args[1], dirBase(args[0], cwd));
      if (dropFailure(result, path)) return null;
      return boundEvent({ ...base, kind: "file", op: "chmod", path });
    }
    case "connect":
      return parseConnect(args[1], base, cwd);
    default:
      return null;
  }
}

/**
 * A successful open's `-y` result is the kernel's path for the opened file,
 * so a symlink (`/tmp/x -> ~/.npmrc`) cannot hide what was read. The
 * process's own `/proc/self` view stays as written: its resolved
 * `/proc/<pid>/...` form would read as another process's memory.
 *
 * @param {string} lexical
 * @param {string | null} resolved
 */
function openedPath(lexical, resolved) {
  if (resolved === null || resolved.endsWith(" (deleted)")) return lexical;
  if (underAny(lexical, ["/proc/self", "/proc/thread-self"])) return lexical;
  return normalizePath(resolved, null);
}

/**
 * Makes `value` absolute against `cwd` when it is relative and the directory
 * is known, then collapses `//`, `.`, and `..` the way the parent's matching
 * expects. Lexical only: symlinks are resolved where the kernel tells us
 * (`openedPath`), not here.
 *
 * @param {string} value
 * @param {string | null} cwd
 * @returns {string}
 */
export function normalizePath(value, cwd) {
  let path = value;
  if (!path.startsWith("/")) {
    if (cwd === null || !cwd.startsWith("/")) return path;
    path = `${cwd}/${path}`;
  }
  path = posix.normalize(path);
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * Re-joins `<unfinished ...>` / `<... name resumed>` halves that `-f` produces
 * when another traced process interleaves, so the parser sees whole calls
 * with their results. Unmatched halves are flushed as-is at the end.
 */
export function createLineJoiner() {
  /** @type {Map<string, string>} */
  const pending = new Map();
  return {
    /** @param {string} line @returns {string[]} */
    push(line) {
      const match = /^(\d+)\s+(.*)$/.exec(line);
      if (!match) return [line];
      const [, pid, body] = match;
      if (UNFINISHED_RE.test(body)) {
        const previous = pending.get(pid);
        pending.set(pid, line.replace(UNFINISHED_RE, " "));
        return previous === undefined ? [] : [`${previous}<unfinished ...>`];
      }
      const resumed = /^<\.\.\. [a-z0-9_]+ resumed>\s?(.*)$/.exec(body);
      if (!resumed) return [line];
      const head = pending.get(pid);
      if (head === undefined) return [];
      pending.delete(pid);
      return [`${head}${resumed[1]}`];
    },
    /** @returns {string[]} */
    flush() {
      const rest = [...pending.values()].map((head) => `${head}<unfinished ...>`);
      pending.clear();
      return rest;
    },
  };
}

/**
 * An execve that failed with ENOENT: one probe of a PATH search. The reader
 * keeps the last probe per pid and reports it only when no probe succeeded,
 * so `curl` on an image without curl still shows up as an exec attempt.
 *
 * @param {string} line
 * @param {DetonationStep} step
 * @param {string} target
 * @returns {HarnessEvent | null}
 */
export function parseMissingExec(line, step, target) {
  const call = parseCall(line);
  if (call === null || (call.name !== "execve" && call.name !== "execveat")) return null;
  if (!call.result?.failed || call.result.errno !== "ENOENT") return null;
  return callEvent(call, step, target, null, true);
}

/**
 * Volume filter for events that every Node or shell process produces. Applies
 * to both syscall and runtime-hook events.
 *
 * @param {HarnessEvent} event
 * @returns {boolean}
 */
export function isNoiseEvent(event) {
  if (event.kind === "exec" || event.kind === "dns") return false;
  if (event.kind === "connect") {
    return (
      event.family === "unix" &&
      (event.address === "/var/run/nscd/socket" || event.address === "/run/nscd/socket")
    );
  }
  const { path, op } = event;
  if (underAny(path, [HOOK_LOG_DIR])) return true;
  if (op !== "read") return underAny(path, ["/dev", "/proc/self"]);
  return (
    underAny(path, [
      "/usr",
      "/lib",
      "/lib64",
      "/etc/ssl",
      "/proc/self",
      "/sys",
      "/dev",
      "/work/app/node_modules",
      // A PyPI run's interpreter environment, build requirements, and the
      // unpacked sdist: every start reads the first, every build the others.
      "/work/venv",
      "/work/build-env",
      "/work/sdist",
      "/opt/drydock",
      "/home/pkg/.node_modules",
      "/home/pkg/.node_libraries",
    ]) ||
    path.startsWith("/etc/ld.so") ||
    NOISE_READ_FILES.has(path)
  );
}

// libc resolver and locale configuration that any process doing a lookup reads.
const NOISE_READ_FILES = new Set([
  "/etc/localtime",
  // Read by every Node process at startup.
  "/proc/meminfo",
  "/proc/sys/vm/overcommit_memory",
  // Module resolution from the harness's own app root.
  "/work/app/package.json",
  "/etc/nsswitch.conf",
  "/etc/host.conf",
  "/etc/gai.conf",
  "/etc/resolv.conf",
  "/etc/hosts",
]);

/**
 * Applies the report bounds to any event, including runtime-hook events the
 * harness reads from a file the package could have written. Paths must already
 * be normalized: clipping first would let a long `/x/../` prefix hide the end.
 *
 * @template {HarnessEvent} T
 * @param {T} event
 * @returns {T}
 */
export function boundEvent(event) {
  if (event.kind === "exec") {
    /** @type {string[]} */
    const argv = [];
    let budget = MAX_ARGV_CHARS;
    for (const arg of event.argv.slice(0, MAX_ARGV_ITEMS)) {
      if (budget <= 0) break;
      const clipped = clip(arg, Math.min(MAX_ARG_CHARS, budget));
      argv.push(clipped);
      budget -= clipped.length;
    }
    return { ...event, path: clip(event.path, MAX_PATH_CHARS), argv };
  }
  if (event.kind === "file") return { ...event, path: clip(event.path, MAX_PATH_CHARS) };
  if (event.kind === "connect") return { ...event, address: clip(event.address, MAX_PATH_CHARS) };
  return { ...event, hostname: clip(event.hostname, MAX_ARG_CHARS) };
}

/**
 * Control characters become `?` here rather than in the parent so a hostile
 * argv cannot grow sixfold as JSON `\u0001` escapes and crowd the report.
 *
 * @param {string} value @param {number} max
 */
function clip(value, max) {
  // eslint-disable-next-line no-control-regex -- replacing C0 is the point
  return (value.length > max ? value.slice(0, max) : value).replace(/[\u0000-\u001f\u007f]/g, "?");
}

/** @param {string} path @param {string[]} prefixes */
function underAny(path, prefixes) {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Failed probes for files that do not exist are mostly module resolution;
 * under a home directory they are credential hunting and are kept.
 *
 * @param {{ failed: boolean, errno: string | null }} result
 * @param {string} path
 */
function dropFailure(result, path) {
  if (!result.failed || result.errno !== "ENOENT") return false;
  return !HOME_PREFIXES.some((prefix) => path.startsWith(prefix) || `${path}/` === prefix);
}

/** @param {string | undefined} flags @returns {"read" | "write" | "create"} */
function openOp(flags) {
  const parts = new Set((flags ?? "").split("|").map((part) => part.trim()));
  if (parts.has("O_CREAT")) return "create";
  if (parts.has("O_WRONLY") || parts.has("O_RDWR")) return "write";
  return "read";
}

/**
 * @param {string | undefined} raw
 * @param {{ step: DetonationStep, target: string, pid: number, via: "syscall" }} base
 * @param {string | null} cwd
 * @returns {HarnessEvent | null}
 */
function parseConnect(raw, base, cwd) {
  if (raw === undefined) return null;
  const family = /sa_family=(AF_[A-Z0-9]+)/.exec(raw)?.[1];
  if (family === "AF_INET" || family === "AF_INET6") {
    const portMatch = /sin6?_port=htons\((\d+)\)/.exec(raw);
    const port = portMatch ? Number(portMatch[1]) : null;
    const addressMatch =
      family === "AF_INET"
        ? /inet_addr\("([^"]*)"\)/.exec(raw)
        : /inet_pton\(AF_INET6,\s*"([^"]*)"/.exec(raw);
    return boundEvent({
      ...base,
      kind: "connect",
      family: family === "AF_INET" ? "inet" : "inet6",
      address: addressMatch?.[1] ?? UNREADABLE,
      port,
    });
  }
  if (family === "AF_UNIX" || family === "AF_LOCAL") {
    const start = raw.indexOf("sun_path=");
    let address = "";
    if (start !== -1) {
      let index = start + "sun_path=".length;
      const abstract = raw[index] === "@";
      if (abstract) index += 1;
      const decoded = decodeQuoted(raw, index, '"');
      if (decoded === null) address = UNREADABLE;
      else address = abstract ? `@${decoded.value}` : normalizePath(decoded.value, cwd);
    }
    return boundEvent({ ...base, kind: "connect", family: "unix", address, port: null });
  }
  return null;
}

/** @param {string | undefined} raw @param {string | null} base */
function pathArg(raw, base) {
  const decoded = decodeString(raw);
  return decoded === null ? UNREADABLE : normalizePath(decoded, base);
}

/**
 * The directory a `*at` call's relative path is relative to: the `-y`
 * annotation when present, else the tracked cwd for a bare `AT_FDCWD`.
 *
 * @param {string | undefined} raw
 * @param {string | null} cwd
 */
function dirBase(raw, cwd) {
  if (raw === undefined) return null;
  const annotated = fdPath(raw);
  if (annotated !== null) return annotated;
  return raw === "AT_FDCWD" ? cwd : null;
}

/** The absolute path `-y` printed for an fd argument such as `3</home/pkg>`. @param {string | undefined} raw */
function fdPath(raw) {
  if (raw === undefined) return null;
  const start = raw.indexOf("<");
  if (start === -1) return null;
  const decoded = decodeQuoted(raw, start, ">");
  return decoded !== null && decoded.value.startsWith("/")
    ? normalizePath(decoded.value, null)
    : null;
}

/** @param {string | undefined} raw */
function fdNumber(raw) {
  return /^-?\d+/.exec(raw ?? "")?.[0] ?? "?";
}

/** @param {string | undefined} raw @returns {string | null} */
function decodeString(raw) {
  if (raw === undefined || !raw.startsWith('"')) return null;
  return decodeQuoted(raw, 0, '"')?.value ?? null;
}

/** @param {string | undefined} raw @returns {string[]} */
function arrayArg(raw) {
  if (raw === undefined || !raw.startsWith("[")) return [UNREADABLE];
  const out = [];
  let index = 1;
  while (index < raw.length && out.length < MAX_ARGV_ITEMS) {
    const char = raw[index];
    if (char === '"') {
      const decoded = decodeQuoted(raw, index, '"');
      if (!decoded) break;
      out.push(decoded.value);
      index = decoded.end;
    } else if (char === "]") {
      break;
    } else {
      index += 1;
    }
  }
  return out;
}

/**
 * Decodes one strace-escaped run starting at `start` (the opening delimiter)
 * up to the unescaped `close`: `"` for string arguments, `>` for `-y` fd
 * annotations (where strace escapes `<`, `>`, and `"`). A trailing `...` after
 * a closing quote marks strace's `-s` truncation and is kept so readers know
 * the value is partial.
 *
 * @param {string} text
 * @param {number} start
 * @param {'"' | ">"} close
 * @returns {{ value: string, end: number } | null}
 */
function decodeQuoted(text, start, close) {
  if (text[start] !== (close === '"' ? '"' : "<")) return null;
  /** @type {number[]} */
  const bytes = [];
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === close) {
      index += 1;
      let value = utf8.decode(new Uint8Array(bytes));
      if (close === '"' && text.startsWith("...", index)) {
        value += "...";
        index += 3;
      }
      return { value, end: index };
    }
    if (char !== "\\") {
      const unit = text.charCodeAt(index);
      if (unit < 0x80) {
        bytes.push(unit);
        index += 1;
        continue;
      }
      const code = text.codePointAt(index) ?? 0;
      for (const byte of utf8Encoder.encode(String.fromCodePoint(code))) bytes.push(byte);
      index += code > 0xffff ? 2 : 1;
      continue;
    }
    const next = text[index + 1];
    const simple = SIMPLE_ESCAPES[next];
    if (simple !== undefined) {
      bytes.push(simple);
      index += 2;
    } else if (next === "x") {
      const hex = /^[0-9a-fA-F]{1,2}/.exec(text.slice(index + 2, index + 4))?.[0] ?? "";
      bytes.push(hex ? Number.parseInt(hex, 16) : 0x78);
      index += 2 + hex.length;
    } else if (next !== undefined && next >= "0" && next <= "7") {
      const octal = /^[0-7]{1,3}/.exec(text.slice(index + 1, index + 4))?.[0] ?? "0";
      bytes.push(Number.parseInt(octal, 8) & 0xff);
      index += 1 + octal.length;
    } else {
      if (next !== undefined) bytes.push(next.charCodeAt(0) & 0xff);
      index += 2;
    }
  }
  return null;
}

/** @type {Record<string, number>} */
const SIMPLE_ESCAPES = {
  '"': 0x22,
  "\\": 0x5c,
  n: 0x0a,
  t: 0x09,
  r: 0x0d,
  v: 0x0b,
  f: 0x0c,
  a: 0x07,
  b: 0x08,
  e: 0x1b,
};

const utf8 = new TextDecoder("utf-8", { fatal: false });
const utf8Encoder = new TextEncoder();

/**
 * Splits the argument list of `name(` at top-level commas, respecting quoted
 * strings, `-y` fd annotations, and nested brackets, so a `)` or `,` inside a
 * path cannot shift arguments.
 *
 * @param {string} body
 * @param {number} start index just past the opening parenthesis
 * @param {boolean} unfinished the line ends mid-arguments
 * @returns {{ args: string[], rest: string } | null}
 */
function scanArgs(body, start, unfinished) {
  /** @type {string[]} */
  const args = [];
  let depth = 0;
  let current = start;
  let index = start;
  while (index < body.length) {
    const char = body[index];
    if (char === '"' || char === "<") {
      const decoded = decodeQuoted(body, index, char === '"' ? '"' : ">");
      if (!decoded) return unfinished ? { args, rest: "" } : null;
      index = decoded.end;
      continue;
    }
    if (char === "[" || char === "{" || char === "(") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
    else if (char === ")") {
      if (depth === 0) {
        pushArg(args, body.slice(current, index));
        return { args, rest: body.slice(index + 1) };
      }
      depth -= 1;
    } else if (char === "," && depth === 0) {
      pushArg(args, body.slice(current, index));
      current = index + 1;
    }
    index += 1;
  }
  if (!unfinished) return null;
  pushArg(args, body.slice(current));
  return { args, rest: "" };
}

/** @param {string[]} args @param {string} raw */
function pushArg(args, raw) {
  const trimmed = raw.trim();
  if (trimmed !== "") args.push(trimmed);
}
