import { isRegistryWrite } from "./egress";
import {
  canaryNeedles,
  DETONATION_HOME,
  redactCanaries,
  type CanaryNeedle,
  type CanarySet,
} from "./canaries";
import type {
  DetonationEgressEvent,
  DetonationSeverity,
  DetonationSignal,
  DetonationSignalId,
  HarnessEvent,
  HarnessEventSource,
  HarnessReport,
} from "./types";

/**
 * Turns raw detonation telemetry into advisory behavior signals.
 *
 * The run happens in a fresh container whose only package is the one under
 * review, so the bar is "would a benign install script do this?". Lifecycle
 * scripts run without npm in the process tree, so a credential read is the
 * package's own, not npm loading its config. PyPI steps start an interpreter
 * with no pip in the tree for the same reason.
 */

const APP_ROOT = "/work/app";
const NODE_MODULES = `${APP_ROOT}/node_modules/`;
const MAX_EVIDENCE = 6;

const SEVERITY_ORDER: Record<DetonationSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const TITLES: Record<DetonationSignalId, string> = {
  "dynamic.canary-exfiltration": "Sent a planted credential off the machine",
  "dynamic.registry-publish-attempt": "Tried to publish or modify packages on the registry",
  "dynamic.network-egress": "Made network requests while installing or loading",
  "dynamic.credential-file-read": "Read credential files",
  "dynamic.persistence-write": "Wrote to a startup, CI, or credential location",
  "dynamic.package-tampering": "Modified installed packages",
  "dynamic.suspicious-process": "Launched a download, network, or secret-scanning tool",
  "dynamic.sensitive-file-read": "Read process environments or browser and wallet data",
};

// containers/detonation/event-budget.mjs mirrors these rules so the harness
// can protect signal-bearing events from floods; a parity test keeps them in step.
const CREDENTIAL_PATHS = [
  ".npmrc",
  ".yarnrc.yml",
  ".pypirc",
  ".git-credentials",
  ".netrc",
  ".docker/config.json",
  ".kube/config",
];
const CREDENTIAL_DIRS = [".ssh/", ".aws/", ".config/gh/", ".config/gcloud/", ".azure/"];

const PERSISTENCE_PATHS = [
  ".bashrc",
  ".bash_profile",
  ".profile",
  ".zshrc",
  ".zprofile",
  ".npmrc",
  ".pypirc",
  ".ssh/authorized_keys",
  ".gitconfig",
];
const PERSISTENCE_DIRS = [".config/autostart/", ".config/systemd/", ".local/bin/"];
const SYSTEM_PERSISTENCE = [
  /^\/etc\/cron/,
  /^\/var\/spool\/cron\//,
  /^\/etc\/ld\.so\.preload$/,
  /^\/etc\/profile/,
];
const REPO_PERSISTENCE = [/\/\.github\/workflows\//, /\/\.git\/hooks\//];
// Every Python interpreter runs these from any site directory at startup, with
// no import of the package (the LiteLLM 1.107.0 `cook.pth` shape). A build
// copying a `.pth` into its own build tree is not in a site directory.
const PYTHON_STARTUP_HOOK =
  /\/(site|dist)-packages\/([^/]+\.pth|sitecustomize\.py|usercustomize\.py)$/;

/** The PyPI run's interpreter environment, which the harness alone installs. */
const PYTHON_ENV_ROOT = "/work/venv/";

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
  // Resolver tools: DNS is the one channel the egress boundary does not record.
  "dig",
  "nslookup",
  "host",
  "drill",
]);
// Inline interpreter code is how node-gyp probes Python, so only code that
// reaches for the network, a shell, or a decoder counts.
const SUSPICIOUS_INLINE_CODE =
  /\b(socket|urllib|requests|http\.client|subprocess|os\.system|base64|IO::Socket|LWP)\b/;
const SUSPICIOUS_SHELL =
  /\b(curl|wget|nc|ncat|socat)\b|\/dev\/tcp\/|base64\s+(-d|--decode)|\beval\b/;

/**
 * Collapses `//`, `.`, and `..` so `/home//pkg/./.npmrc` matches `~/.npmrc`.
 * The harness resolves relative paths against the process cwd; this is the
 * parent's own guarantee for the absolute ones.
 */
function normalizePath(path: string): string {
  if (!path.startsWith("/")) return path;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function homePath(relative: string): string {
  return `${DETONATION_HOME}/${relative}`;
}

function isUnder(path: string, relativePaths: string[], relativeDirs: string[]): boolean {
  return (
    relativePaths.some((relative) => path === homePath(relative)) ||
    relativeDirs.some((relative) => path.startsWith(homePath(relative)))
  );
}

/** `left-pad@1.3.0:postinstall` → `left-pad`; `@scope/x:require` → `@scope/x`. */
function packageOfTarget(target: string): string | null {
  const scoped = target.startsWith("@");
  const body = scoped ? target.slice(1) : target;
  const end = body.search(/[@:]/);
  const name = end === -1 ? body : body.slice(0, end);
  return name ? (scoped ? `@${name}` : name) : null;
}

/** The installed package a `node_modules` path belongs to, or null outside `node_modules`. */
function packageOfPath(path: string): string | null {
  const index = path.lastIndexOf("/node_modules/");
  if (index === -1 || !path.startsWith(NODE_MODULES)) return null;
  const parts = path.slice(index + "/node_modules/".length).split("/");
  // Dot directories (`.bin`, `.cache`, Prisma's `.prisma`) are shared
  // generated output, not another package.
  if (!parts[0] || parts[0].startsWith(".")) return null;
  return parts[0].startsWith("@") && parts[1] ? `${parts[0]}/${parts[1]}` : parts[0];
}

function isWrite(event: HarnessEvent): boolean {
  return event.kind === "file" && event.op !== "read";
}

function isTampering(event: HarnessEvent): boolean {
  if (!isWrite(event) || event.kind !== "file") return false;
  if (event.path === `${APP_ROOT}/package.json`) return true;
  // pip compiled every module at install, so runtime bytecode caches are the
  // only expected writes into the installed environment.
  if (event.path.startsWith(PYTHON_ENV_ROOT)) return !event.path.includes("/__pycache__/");
  const owner = packageOfPath(event.path);
  if (owner === null) return false;
  // A build step writing into its own directory is how native addons install.
  return event.step !== "lifecycle" || owner !== packageOfTarget(event.target);
}

function isPersistence(event: HarnessEvent): boolean {
  if (!isWrite(event) || event.kind !== "file") return false;
  return (
    isUnder(event.path, PERSISTENCE_PATHS, PERSISTENCE_DIRS) ||
    SYSTEM_PERSISTENCE.some((pattern) => pattern.test(event.path)) ||
    REPO_PERSISTENCE.some((pattern) => pattern.test(event.path)) ||
    PYTHON_STARTUP_HOOK.test(event.path)
  );
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function isSuspiciousExec(event: HarnessEvent): boolean {
  if (event.kind !== "exec") return false;
  if (SUSPICIOUS_BINARIES.has(basename(event.path))) return true;
  const name = basename(event.path);
  if ((name === "sh" || name === "bash" || name === "dash") && event.argv[1] === "-c") {
    return SUSPICIOUS_SHELL.test(event.argv.slice(2).join(" "));
  }
  if (name.startsWith("python") || name === "perl") {
    const flag = event.argv.findIndex((arg) => arg === "-c" || arg === "-e");
    return flag !== -1 && SUSPICIOUS_INLINE_CODE.test(event.argv.slice(flag + 1).join(" "));
  }
  return false;
}

function isOutboundConnect(event: HarnessEvent): boolean {
  if (event.kind !== "connect" || event.family === "unix") return false;
  // Resolver traffic is reported by name through the `dns` events instead.
  if (event.port === 53) return false;
  return !/^(127\.|::1$|0\.0\.0\.0$|::ffff:127\.)/.test(event.address);
}

// Root-owned in the image, so package code (uid 10001) cannot plant a
// program at these paths. A shim earlier on PATH (`node_modules/.bin/npm`)
// runs from its own path and gets no exemption, and neither does argv[0].
// The launchers are `#!/usr/bin/env node` scripts (yarn's is a shell script
// ending in `exec node .../yarn.js`), so strace shows the launcher exec and
// then node re-exec'd on the same pid with the script as argv[1]. A flag before
// the script (`node --require x npm`) breaks the match; NODE_OPTIONS does not,
// which is a documented gap (docs/detonation-sandbox.md).
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
const YARN_SCRIPT = /^\/opt\/yarn-v[0-9.]+\/bin\/yarn\.js$/;
// Package-manager config that npm, npx, or yarn read on every invocation.
const PACKAGE_MANAGER_CONFIG = [".npmrc", ".yarnrc.yml"].map(homePath);

function isPackageManagerExec(event: HarnessEvent & { kind: "exec" }): boolean {
  const script = event.argv[1] ?? "";
  return (
    PACKAGE_MANAGER_BINARIES.has(event.path) ||
    (event.path === "/usr/local/bin/node" &&
      (PACKAGE_MANAGER_BINARIES.has(script) ||
        PACKAGE_MANAGER_SCRIPTS.has(script) ||
        YARN_SCRIPT.test(script)))
  );
}

function describeEvent(event: HarnessEvent): string {
  const where = `${event.target}`;
  switch (event.kind) {
    case "exec":
      return `${where}: ran ${event.argv.join(" ") || event.path}`.slice(0, 300);
    case "file":
      return `${where}: ${event.op} ${event.path}`;
    case "connect":
      return `${where}: connect ${event.address}${event.port === null ? "" : `:${event.port}`}`;
    case "dns":
      return `${where}: resolved ${event.hostname}`;
  }
}

function describeEgress(event: DetonationEgressEvent): string {
  const canaries = event.canaryHits.length ? ` carrying ${event.canaryHits.join(", ")}` : "";
  const body = event.bodyBytes ? ` (${event.bodyBytes} byte body)` : "";
  return `${event.method} ${event.host}${event.path}${body}${canaries}`;
}

class SignalBuilder {
  private readonly signals = new Map<
    DetonationSignalId,
    {
      severity: DetonationSeverity;
      evidence: Set<string>;
      source: DetonationSignal["source"];
      step: DetonationSignal["step"];
    }
  >();

  // Evidence carries argv, which can carry a planted credential verbatim.
  constructor(private readonly needles: readonly CanaryNeedle[]) {}

  add(
    id: DetonationSignalId,
    severity: DetonationSeverity,
    rawEvidence: string,
    source: DetonationSignal["source"],
    step: DetonationSignal["step"],
  ) {
    const evidence = redactCanaries(rawEvidence, this.needles);
    const existing = this.signals.get(id);
    if (!existing) {
      this.signals.set(id, { severity, evidence: new Set([evidence]), source, step });
      return;
    }
    if (SEVERITY_ORDER[severity] < SEVERITY_ORDER[existing.severity]) existing.severity = severity;
    // Prefer the source the package cannot tamper with when both saw it.
    if (rank(source) < rank(existing.source)) existing.source = source;
    if (existing.evidence.size < MAX_EVIDENCE) existing.evidence.add(evidence);
  }

  build(): DetonationSignal[] {
    return Array.from(this.signals, ([id, value]) => ({
      id,
      severity: value.severity,
      title: TITLES[id],
      evidence: Array.from(value.evidence),
      source: value.source,
      step: value.step,
    })).sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  }
}

function rank(source: DetonationSignal["source"]): number {
  const order: Record<"egress" | HarnessEventSource, number> = {
    egress: 0,
    syscall: 1,
    "runtime-hook": 2,
  };
  return order[source];
}

export function classifyDetonation(
  report: HarnessReport | null,
  egress: readonly DetonationEgressEvent[],
  canaries: CanarySet["values"] = [],
): DetonationSignal[] {
  const signals = new SignalBuilder(canaryNeedles(canaries));

  for (const event of egress) {
    // Prepare-phase traffic is npm or pip resolving dependencies with no
    // package code running.
    if (event.phase !== "detonate") continue;
    const description = describeEgress(event);
    if (event.canaryHits.length > 0) {
      signals.add("dynamic.canary-exfiltration", "critical", description, "egress", null);
    }
    if (isRegistryWrite(event)) {
      signals.add("dynamic.registry-publish-attempt", "critical", description, "egress", null);
    }
    const sendsData = event.bodyBytes > 0 || (event.method !== "GET" && event.method !== "HEAD");
    signals.add(
      "dynamic.network-egress",
      sendsData ? "high" : "medium",
      description,
      "egress",
      null,
    );
  }

  const events = (report?.events ?? []).map((event) =>
    event.kind === "file" || event.kind === "exec"
      ? { ...event, path: normalizePath(event.path) }
      : event,
  );
  // Pids whose current program is a package manager, replayed in event order
  // per step exactly as the harness buffer does. `"postinstall": "npm run
  // build"` makes npm read `~/.npmrc` for its own config, which is not the
  // package reading credentials; a read before the pid became npm is.
  // Anything npm is made to send still crosses the egress boundary.
  const managers = new Set<number>();
  let managerStep = "";
  for (const event of events) {
    const step = `${event.step}\n${event.target}`;
    if (step !== managerStep) {
      managers.clear();
      managerStep = step;
    }
    if (event.kind === "exec") {
      if (isPackageManagerExec(event)) managers.add(event.pid);
      else managers.delete(event.pid);
    }
    const description = describeEvent(event);
    if (event.kind === "file" && event.op === "read") {
      const managerConfig = managers.has(event.pid) && PACKAGE_MANAGER_CONFIG.includes(event.path);
      if (!managerConfig && isUnder(event.path, CREDENTIAL_PATHS, CREDENTIAL_DIRS)) {
        signals.add("dynamic.credential-file-read", "high", description, event.via, event.step);
      } else if (SENSITIVE_READS.some((pattern) => pattern.test(event.path))) {
        signals.add("dynamic.sensitive-file-read", "medium", description, event.via, event.step);
      }
    }
    if (isPersistence(event)) {
      signals.add("dynamic.persistence-write", "high", description, event.via, event.step);
    }
    if (isTampering(event)) {
      signals.add("dynamic.package-tampering", "high", description, event.via, event.step);
    }
    if (isSuspiciousExec(event)) {
      signals.add("dynamic.suspicious-process", "medium", description, event.via, event.step);
    }
    if (isOutboundConnect(event) || (event.kind === "dns" && event.hostname !== "localhost")) {
      signals.add("dynamic.network-egress", "medium", description, event.via, event.step);
    }
  }

  return signals.build();
}
