// Pure event bounding for the detonation harness. The package decides how many
// events it produces, so it can try to bury one credential read under
// thousands of junk events. Bounds therefore keep events by value, not by
// arrival: every event that can raise a parent signal goes to a protected
// bucket per signal category, which only events of that same category can
// fill, so a flood can only crowd out evidence for a signal it already raised.
// Everything else is kept by tier as context.

/** @typedef {import("../../server/lib/detonation/types.ts").HarnessEvent} HarnessEvent */

/** Unprotected events kept per step, after dedupe. */
const MAX_STEP_EVENTS = 300;
/** Distinct events kept per signal category per step. */
const MAX_CATEGORY_EVENTS = 64;
/** The parent's `parseHarnessReport` keeps at most this many events. */
export const MAX_REPORT_EVENTS = 2000;
/** Under the parent's 4 MiB harness response limit, with room for the envelope. */
export const MAX_REPORT_BYTES = 3 * 1024 * 1024;

const TIERS = 6;
/**
 * Slots each high-value tier is guaranteed before slots are filled strictly by
 * tier, so flooding one high tier (300 distinct execs) cannot also erase every
 * connect and credential read in the step.
 */
const TIER_FLOOR = 30;

const SCRATCH_DIRS = ["/tmp", "/var/tmp", "/dev/shm"];
const SENSITIVE_DIRS = ["/home/pkg", "/root", "/etc"];
const PROC_PID_RE = /^\/proc\/\d+(?:\/|$)/;

/** @param {string} path @param {string[]} prefixes */
function underAny(path, prefixes) {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** @param {string} path */
function isSensitivePath(path) {
  return underAny(path, SENSITIVE_DIRS) || PROC_PID_RE.test(path);
}

/**
 * Higher is kept first: 5 exec, 4 mutation outside scratch dirs, 3 any file op
 * under a home directory, `/etc`, or another process's `/proc/<pid>`,
 * 2 connect, 1 dns, 0 everything else (scratch writes and other reads).
 *
 * @param {HarnessEvent} event
 * @returns {number}
 */
export function eventTier(event) {
  switch (event.kind) {
    case "exec":
      return 5;
    case "connect":
      return 2;
    case "dns":
      return 1;
    default:
      if (event.op !== "read" && !underAny(event.path, SCRATCH_DIRS)) return 4;
      return isSensitivePath(event.path) ? 3 : 0;
  }
}

// Mirrors of the parent's signal rules in `server/lib/detonation/classify.ts`.
// `test/detonation-classify.test.ts` checks the two agree on a corpus; a
// drift here only demotes an event to the tiered context buckets.
const HOME = "/home/pkg";
const APP_ROOT = "/work/app";
const NODE_MODULES = `${APP_ROOT}/node_modules/`;
/** @param {string} relative */
const home = (relative) => `${HOME}/${relative}`;
const CREDENTIAL_FILES = new Set(
  [
    ".npmrc",
    ".yarnrc.yml",
    ".git-credentials",
    ".netrc",
    ".docker/config.json",
    ".kube/config",
  ].map(home),
);
const CREDENTIAL_DIRS = [".ssh/", ".aws/", ".config/gh/", ".config/gcloud/", ".azure/"].map(home);
const PERSISTENCE_FILES = new Set(
  [
    ".bashrc",
    ".bash_profile",
    ".profile",
    ".zshrc",
    ".zprofile",
    ".npmrc",
    ".ssh/authorized_keys",
    ".gitconfig",
  ].map(home),
);
const PERSISTENCE_DIRS = [".config/autostart/", ".config/systemd/", ".local/bin/"].map(home);
const PERSISTENCE_PATTERNS = [
  /^\/etc\/cron/,
  /^\/var\/spool\/cron\//,
  /^\/etc\/ld\.so\.preload$/,
  /^\/etc\/profile/,
  /\/\.github\/workflows\//,
  /\/\.git\/hooks\//,
];
const SENSITIVE_READS = [
  /^\/etc\/shadow$/,
  /^\/proc\/\d+\/(environ|mem)$/,
  /\/\.config\/(google-chrome|chromium|BraveSoftware)\//,
  /\/\.mozilla\//,
  /\/\.(electrum|bitcoin|ethereum)\//,
  /\/\.config\/(Exodus|atomic|Ledger Live)\//,
];
const SUSPICIOUS_BINARIES = new Set([
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "socat",
  "ssh",
  "scp",
  "gh",
  "trufflehog",
  "crontab",
  "systemctl",
  "nohup",
  "xxd",
  "dig",
  "nslookup",
  "host",
  "drill",
]);
const SUSPICIOUS_INLINE_CODE =
  /\b(socket|urllib|requests|http\.client|subprocess|os\.system|base64|IO::Socket|LWP)\b/;
const SUSPICIOUS_SHELL =
  /\b(curl|wget|nc|ncat|socat)\b|\/dev\/tcp\/|base64\s+(-d|--decode)|\beval\b/;
const PACKAGE_MANAGER_BINARIES = new Set(
  ["npm", "npx", "yarn", "yarnpkg", "pnpm", "pnpx", "corepack"].map(
    (name) => `/usr/local/bin/${name}`,
  ),
);
const PACKAGE_MANAGER_SCRIPTS = new Set([
  "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
  "/usr/local/lib/node_modules/npm/bin/npx-cli.js",
  "/usr/local/lib/node_modules/corepack/dist/corepack.js",
]);
const YARN_SCRIPT_RE = /^\/opt\/yarn-v[0-9.]+\/bin\/yarn\.js$/;
const PACKAGE_MANAGER_CONFIG = new Set([".npmrc", ".yarnrc.yml"].map(home));

/** @param {string} path */
const basename = (path) => path.slice(path.lastIndexOf("/") + 1);

/** @param {HarnessEvent & { kind: "exec" }} event */
function isPackageManagerExec(event) {
  if (PACKAGE_MANAGER_BINARIES.has(event.path)) return true;
  if (event.path !== "/usr/local/bin/node") return false;
  const script = event.argv[1] ?? "";
  return (
    PACKAGE_MANAGER_BINARIES.has(script) ||
    PACKAGE_MANAGER_SCRIPTS.has(script) ||
    YARN_SCRIPT_RE.test(script)
  );
}

/** @param {HarnessEvent & { kind: "exec" }} event */
function isSuspiciousExec(event) {
  const name = basename(event.path);
  if (SUSPICIOUS_BINARIES.has(name)) return true;
  if ((name === "sh" || name === "bash" || name === "dash") && event.argv[1] === "-c") {
    return SUSPICIOUS_SHELL.test(event.argv.slice(2).join(" "));
  }
  if (name.startsWith("python") || name === "perl") {
    const flag = event.argv.findIndex((arg) => arg === "-c" || arg === "-e");
    return flag !== -1 && SUSPICIOUS_INLINE_CODE.test(event.argv.slice(flag + 1).join(" "));
  }
  return false;
}

/** `left-pad@1.3.0:postinstall` → `left-pad`; `@scope/x:require` → `@scope/x`. @param {string} target */
function packageOfTarget(target) {
  const scoped = target.startsWith("@");
  const body = scoped ? target.slice(1) : target;
  const end = body.search(/[@:]/);
  const name = end === -1 ? body : body.slice(0, end);
  return name ? (scoped ? `@${name}` : name) : null;
}

/** @param {string} path */
function packageOfPath(path) {
  const index = path.lastIndexOf("/node_modules/");
  if (index === -1 || !path.startsWith(NODE_MODULES)) return null;
  const parts = path.slice(index + "/node_modules/".length).split("/");
  if (!parts[0] || parts[0].startsWith(".")) return null;
  return parts[0].startsWith("@") && parts[1] ? `${parts[0]}/${parts[1]}` : parts[0];
}

/**
 * The parent signal an event can raise, or null for context-only events.
 * `manager` is not a signal: it keeps the execs the parent needs to recognize
 * a package manager reading its own config, and any later exec on that pid.
 *
 * @param {HarnessEvent} event
 * @param {ReadonlySet<number>} managers pids currently running a package manager
 * @returns {"manager" | "process" | "credential" | "sensitive" | "persistence" | "tampering" | "network" | null}
 */
function signalCategory(event, managers) {
  switch (event.kind) {
    case "exec":
      if (managers.has(event.pid) || isPackageManagerExec(event)) return "manager";
      return isSuspiciousExec(event) ? "process" : null;
    case "connect":
      if (event.family === "unix" || event.port === 53) return null;
      return /^(127\.|::1$|0\.0\.0\.0$|::ffff:127\.)/.test(event.address) ? null : "network";
    case "dns":
      return event.hostname === "localhost" ? null : "network";
    default: {
      const { path } = event;
      if (event.op === "read") {
        if (CREDENTIAL_FILES.has(path) || CREDENTIAL_DIRS.some((dir) => path.startsWith(dir))) {
          return managers.has(event.pid) && PACKAGE_MANAGER_CONFIG.has(path) ? null : "credential";
        }
        return SENSITIVE_READS.some((pattern) => pattern.test(path)) ? "sensitive" : null;
      }
      if (
        PERSISTENCE_FILES.has(path) ||
        PERSISTENCE_DIRS.some((dir) => path.startsWith(dir)) ||
        PERSISTENCE_PATTERNS.some((pattern) => pattern.test(path))
      ) {
        return "persistence";
      }
      if (path === `${APP_ROOT}/package.json`) return "tampering";
      const owner = packageOfPath(path);
      if (owner === null) return null;
      return event.step !== "lifecycle" || owner !== packageOfTarget(event.target)
        ? "tampering"
        : null;
    }
  }
}

/**
 * Identity for dedupe. Pid is ignored for volume, except for file events on
 * credential-bearing paths, where the parent tells a package manager's own
 * config read from its child's by pid.
 *
 * @param {HarnessEvent} event
 * @returns {string}
 */
export function dedupeKey(event) {
  const { pid, ...identity } = event;
  if (event.kind === "file" && (isSensitivePath(event.path) || underAny(event.path, ["/proc"]))) {
    return JSON.stringify({ ...identity, pid });
  }
  return JSON.stringify(identity);
}

/**
 * @typedef {{ event: HarnessEvent, category: string | null }} KeptEvent
 */

/**
 * Collects one step's events in bounded memory. Signal-bearing events go to
 * their category's bucket (first `categoryCap` distinct each); the rest keep
 * only each tier's first `cap` distinct events, which is all `finish` could
 * ever select from it.
 *
 * @param {{ cap?: number, categoryCap?: number }} [limits]
 */
export function createStepEventBuffer({
  cap = MAX_STEP_EVENTS,
  categoryCap = MAX_CATEGORY_EVENTS,
} = {}) {
  /** @type {{ index: number, event: HarnessEvent }[][]} */
  const tiers = Array.from({ length: TIERS }, () => []);
  /** @type {Map<string, { index: number, event: HarnessEvent }[]>} */
  const categories = new Map();
  /** @type {Set<number>} */
  const managers = new Set();
  // Keys of kept events only, so a flood cannot grow the set without bound.
  const seen = new Set();
  let index = 0;
  let dropped = 0;

  return {
    /** @param {HarnessEvent} event */
    add(event) {
      const category = signalCategory(event, managers);
      // Same order as the parent's replay: an exec decides the pid's program
      // for every event after it.
      if (event.kind === "exec") {
        if (isPackageManagerExec(event)) managers.add(event.pid);
        else managers.delete(event.pid);
      }
      if (category !== null) {
        // The parent needs each package manager pid's exec, so those keep it.
        const key = `${category}:${category === "manager" ? JSON.stringify(event) : dedupeKey(event)}`;
        if (seen.has(key)) return;
        const bucket = categories.get(category) ?? [];
        if (bucket.length >= categoryCap) {
          dropped += 1;
          return;
        }
        categories.set(category, bucket);
        seen.add(key);
        bucket.push({ index: index++, event });
        return;
      }
      const key = dedupeKey(event);
      if (seen.has(key)) return;
      const bucket = tiers[eventTier(event)];
      if (bucket.length >= cap) {
        dropped += 1;
        return;
      }
      seen.add(key);
      bucket.push({ index: index++, event });
    },
    /** @returns {{ events: KeptEvent[], dropped: number }} */
    finish() {
      const take = Array.from({ length: TIERS }, () => 0);
      let used = 0;
      for (let tier = TIERS - 1; tier >= 1; tier -= 1) {
        take[tier] = Math.min(tiers[tier].length, TIER_FLOOR, cap - used);
        used += take[tier];
      }
      for (let tier = TIERS - 1; tier >= 0; tier -= 1) {
        const more = Math.min(tiers[tier].length - take[tier], cap - used);
        take[tier] += more;
        used += more;
      }
      /** @type {{ index: number, kept: KeptEvent }[]} */
      const kept = tiers.flatMap((bucket, tier) =>
        bucket.slice(0, take[tier]).map((entry) => ({
          index: entry.index,
          kept: { event: entry.event, category: null },
        })),
      );
      for (const [category, bucket] of categories) {
        for (const entry of bucket)
          kept.push({ index: entry.index, kept: { event: entry.event, category } });
      }
      for (let tier = 0; tier < TIERS; tier += 1) dropped += tiers[tier].length - take[tier];
      kept.sort((a, b) => a.index - b.index);
      return { events: kept.map((entry) => entry.kept), dropped };
    },
  };
}

/**
 * Drops events until at most `maxEvents` remain and their serialized size
 * fits `maxBytes`, preserving order. Context events go before signal-bearing
 * ones. Within each class the share is fair: every step's (and category's or
 * tier's) latest events go first, so one step's volume cannot erase another
 * step's evidence. Ties drop lower tiers, then steps that are not the
 * reviewed package's own, then later events.
 *
 * @param {KeptEvent[]} entries
 * @param {{ maxEvents: number, maxBytes: number, preferred: (event: HarnessEvent) => boolean }} limits
 * @returns {{ events: HarnessEvent[], dropped: number }}
 */
export function fitEvents(entries, { maxEvents, maxBytes, preferred }) {
  // +1 for the separating comma in the array.
  const sizes = entries.map(({ event }) => Buffer.byteLength(JSON.stringify(event)) + 1);
  let bytes = sizes.reduce((sum, size) => sum + size, 0);
  let count = entries.length;
  const all = entries.map(({ event }) => event);
  if (count <= maxEvents && bytes <= maxBytes) return { events: all, dropped: 0 };

  /** @type {Map<string, number>} */
  const groupSizes = new Map();
  const order = entries.map(({ event, category }, index) => {
    const tier = eventTier(event);
    const group = `${event.step}\n${event.target}\n${category ?? `tier:${tier}`}`;
    const rank = groupSizes.get(group) ?? 0;
    groupSizes.set(group, rank + 1);
    return {
      index,
      protectedEvent: category === null ? 0 : 1,
      rank,
      preferred: preferred(event) ? 1 : 0,
      tier,
    };
  });
  order.sort(
    (a, b) =>
      a.protectedEvent - b.protectedEvent ||
      b.rank - a.rank ||
      a.tier - b.tier ||
      a.preferred - b.preferred ||
      b.index - a.index,
  );
  const drop = new Set();
  for (const entry of order) {
    if (count <= maxEvents && bytes <= maxBytes) break;
    drop.add(entry.index);
    count -= 1;
    bytes -= sizes[entry.index];
  }
  return { events: all.filter((_, index) => !drop.has(index)), dropped: drop.size };
}
