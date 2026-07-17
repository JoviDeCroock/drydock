// Rebuild step logic: the command sequence a rebuild attestation runs inside
// the disposable container, plus the defensive parsers for everything the
// container reports back. Pure (no Cloudflare imports) so the node test suite
// can exercise it against a scripted exec runner; `rebuild-sandbox.ts` binds it
// to the real Sandbox container. See that module for the isolation contract.

import type { RebuildPlan, RebuildRef } from "./rebuild-attestation";

export interface RebuildStepRecord {
  step: string;
  exitCode: number;
  durationMs: number;
  /** Bounded stderr tail; repository-controlled text, render-safe only. */
  detail: string | null;
}

export type RebuildExecution =
  | {
      ok: true;
      ref: RebuildRef;
      toolchain: { packageManager: string | null; node: string | null };
      output: { tarballSha1: string | null; files: Array<{ path: string; sha256: string }> };
      steps: RebuildStepRecord[];
    }
  | { ok: false; failure: string; steps: RebuildStepRecord[] };

const WORKDIR = "/workspace/rebuild";
const CLONE_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 420_000;
const BUILD_TIMEOUT_MS = 600_000;
const PACK_TIMEOUT_MS = 300_000;
const HASH_TIMEOUT_MS = 120_000;
const MAX_DETAIL = 200;
const MAX_MANIFEST_BYTES = 4_000_000;
const MAX_MANIFEST_FILES = 20_000;
const SUPPORTED_PACKAGE_MANAGERS = new Set(["npm", "pnpm"]);

interface SandboxExecutor {
  exec(
    command: string,
    options?: { timeout?: number; cwd?: string },
  ): Promise<{
    success: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    duration: number;
  }>;
}

/** Exported for tests: the step logic against any exec-shaped runner. */
export async function runRebuildSteps(
  sandbox: SandboxExecutor,
  plan: RebuildPlan,
): Promise<RebuildExecution> {
  const steps: RebuildStepRecord[] = [];
  const run = async (step: string, command: string, timeout: number) => {
    const result = await sandbox.exec(command, { timeout });
    steps.push({
      step,
      exitCode: result.exitCode,
      durationMs: Math.max(0, Math.round(result.duration)),
      detail: result.success ? null : boundedDetail(result.stderr || result.stdout),
    });
    return result;
  };

  const repoDir = `${WORKDIR}/repo`;
  const pkgDir = plan.directory ? `${repoDir}/${plan.directory}` : repoDir;

  await run("prepare", `rm -rf ${shq(WORKDIR)} && mkdir -p ${shq(WORKDIR)}`, 30_000);

  // Checkout: try each candidate ref until one resolves. gitHead needs a
  // fetch-by-sha (GitHub/GitLab allow any-sha fetches); tags use a shallow
  // branch clone.
  let ref: RebuildRef | null = null;
  for (const candidate of plan.refs) {
    const command =
      candidate.kind === "git-head"
        ? [
            `rm -rf ${shq(repoDir)}`,
            `git init -q ${shq(repoDir)}`,
            `git -C ${shq(repoDir)} remote add origin ${shq(plan.repository)}`,
            `git -C ${shq(repoDir)} fetch -q --depth 1 origin ${shq(candidate.value)}`,
            `git -C ${shq(repoDir)} checkout -q FETCH_HEAD`,
          ].join(" && ")
        : [
            `rm -rf ${shq(repoDir)}`,
            `git clone -q --depth 1 --branch ${shq(candidate.value)} ${shq(plan.repository)} ${shq(repoDir)}`,
          ].join(" && ");
    const result = await run(
      `checkout ${candidate.kind} ${candidate.value}`,
      command,
      CLONE_TIMEOUT_MS,
    );
    if (result.success) {
      ref = candidate;
      break;
    }
  }
  if (!ref) return { ok: false, failure: "checkout-failed", steps };

  // Read the repository manifest Worker-side and decide the strategy here;
  // the container never interprets its own contents beyond running commands.
  const manifestRead = await run(
    "read manifest",
    `cat ${shq(`${pkgDir}/package.json`)} && echo && ls -1 ${shq(pkgDir)}`,
    30_000,
  );
  if (!manifestRead.success) return { ok: false, failure: "manifest-missing", steps };
  const strategy = detectStrategy(manifestRead.stdout);
  if (!strategy) return { ok: false, failure: "unsupported-package-manager", steps };

  if (strategy.corepackSpec) {
    const prepared = await run(
      "toolchain",
      `corepack enable && corepack prepare ${shq(strategy.corepackSpec)} --activate`,
      120_000,
    );
    if (!prepared.success) return { ok: false, failure: "toolchain-unavailable", steps };
  }
  const versions = await run(
    "versions",
    `node --version && ${strategy.packageManager} --version`,
    30_000,
  );
  const [nodeVersion, pmVersion] = versions.success
    ? versions.stdout.split("\n").map((line) => line.trim().slice(0, 64))
    : [null, null];

  // Dependency lifecycle scripts are the widest arbitrary-code surface, so the
  // install always runs with scripts disabled. The package's own build/prepack
  // scripts run afterwards — that *is* the rebuild — inside this credential-
  // free, egress-restricted container.
  // Install always runs at the repository root so monorepo workspace graphs
  // resolve; the build/pack steps then run in the package directory.
  const install = await run("install", installCommand(strategy, repoDir), INSTALL_TIMEOUT_MS);
  if (!install.success) return { ok: false, failure: "install-failed", steps };

  if (strategy.hasBuildScript) {
    const build = await run(
      "build",
      `cd ${shq(pkgDir)} && ${strategy.packageManager} run build`,
      BUILD_TIMEOUT_MS,
    );
    if (!build.success) return { ok: false, failure: "build-failed", steps };
  }

  const outDir = `${WORKDIR}/out`;
  const pack = await run(
    "pack",
    `mkdir -p ${shq(outDir)} && cd ${shq(pkgDir)} && ${strategy.packageManager} pack --pack-destination ${shq(outDir)}`,
    PACK_TIMEOUT_MS,
  );
  if (!pack.success) return { ok: false, failure: "pack-failed", steps };

  // Hash manifest: first line is the tarball SHA-1, the rest are
  // `<sha256>  <path>` lines for the unpacked contents. Bounded with head -c
  // so a hostile build cannot flood the Worker.
  const hash = await run(
    "hash",
    [
      `cd ${shq(outDir)}`,
      `T=$(ls -1 *.tgz | head -n 1)`,
      `sha1sum "$T" | cut -d" " -f1`,
      `rm -rf x && mkdir x && tar -xzf "$T" -C x`,
      `cd x/*/ && find . -type f -print0 | sort -z | xargs -0 sha256sum | head -c ${MAX_MANIFEST_BYTES}`,
    ].join(" && "),
    HASH_TIMEOUT_MS,
  );
  if (!hash.success) return { ok: false, failure: "hash-failed", steps };

  const output = parseHashOutput(hash.stdout);
  if (!output) return { ok: false, failure: "hash-unparseable", steps };

  return {
    ok: true,
    ref,
    toolchain: {
      packageManager: pmVersion
        ? `${strategy.packageManager}@${pmVersion}`
        : strategy.packageManager,
      node: nodeVersion,
    },
    output,
    steps,
  };
}

interface RebuildStrategy {
  packageManager: "npm" | "pnpm";
  corepackSpec: string | null;
  hasBuildScript: boolean;
}

// `stdout` is `cat package.json`, a blank line, then `ls -1` of the package
// directory. Hostile input: parsed defensively, unknown managers rejected.
function detectStrategy(stdout: string): RebuildStrategy | null {
  const separator = stdout.lastIndexOf("\n\n");
  const manifestText = separator === -1 ? stdout : stdout.slice(0, separator);
  const listing = separator === -1 ? "" : stdout.slice(separator + 2);

  let manifest: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(manifestText) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      manifest = parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  let packageManager: "npm" | "pnpm" | null = null;
  let corepackSpec: string | null = null;
  const declared =
    typeof manifest.packageManager === "string" ? manifest.packageManager.trim() : "";
  const declaredMatch = /^(npm|pnpm|yarn)@\d+[\w.+-]*$/.exec(declared);
  if (declaredMatch) {
    if (!SUPPORTED_PACKAGE_MANAGERS.has(declaredMatch[1])) return null;
    packageManager = declaredMatch[1] as "npm" | "pnpm";
    corepackSpec = declared;
  } else {
    const files = new Set(listing.split("\n").map((line) => line.trim()));
    if (files.has("pnpm-lock.yaml")) {
      packageManager = "pnpm";
      corepackSpec = "pnpm@latest";
    } else if (files.has("yarn.lock")) {
      return null;
    } else {
      packageManager = "npm";
    }
  }

  const scripts = manifest.scripts;
  const hasBuildScript =
    !!scripts &&
    typeof scripts === "object" &&
    !Array.isArray(scripts) &&
    typeof (scripts as Record<string, unknown>).build === "string";

  return { packageManager, corepackSpec, hasBuildScript };
}

function installCommand(strategy: RebuildStrategy, rootDir: string): string {
  if (strategy.packageManager === "pnpm") {
    // Workspace installs happen at the repo root; --ignore-scripts covers
    // dependency lifecycle hooks. Frozen lockfile keeps the tree at what the
    // repository pinned; fall back to a plain install when out of sync.
    return `cd ${shq(rootDir)} && (pnpm install --ignore-scripts --frozen-lockfile || pnpm install --ignore-scripts)`;
  }
  return `cd ${shq(rootDir)} && (npm ci --ignore-scripts --no-audit --no-fund || npm install --ignore-scripts --no-audit --no-fund)`;
}

function parseHashOutput(stdout: string): {
  tarballSha1: string | null;
  files: Array<{ path: string; sha256: string }>;
} | null {
  const lines = stdout.split("\n");
  const tarballSha1 = /^[0-9a-f]{40}$/.test(lines[0]?.trim() ?? "") ? lines[0].trim() : null;
  const files: Array<{ path: string; sha256: string }> = [];
  for (const line of lines.slice(1)) {
    const match = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    if (files.length >= MAX_MANIFEST_FILES) return null;
    files.push({ path: match[2], sha256: match[1] });
  }
  if (!files.length) return null;
  return { tarballSha1, files };
}

function boundedDetail(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.slice(-MAX_DETAIL);
}

// POSIX single-quote escaping; every interpolated value goes through this even
// though plan fields are already charset-validated upstream.
function shq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
