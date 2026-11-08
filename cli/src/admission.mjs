// @ts-check
import { terminalSafeJson } from "./format.mjs";
import { CliError } from "./client.mjs";
import { validateAdmissionManifest } from "./admission-manifest.mjs";
import { parseAdmissionLock, textDigest } from "./admission-lockfile.mjs";
import {
  ADMISSION_POLICY,
  admissionHolds,
  readAdmissionDiff,
  verifyLockedArchive,
} from "./admission-evidence.mjs";

/**
 * A preflight, not a package-manager wrapper. Its caller must keep the lockfile
 * immutable and stop before installation unless this process returns zero.
 * @param {import('./main.mjs').CommandContext} ctx
 */
export async function admit(ctx) {
  const [targetPath, ...extra] = ctx.positionals.slice(1);
  const baselinePath = ctx.values.baseline;
  const output = ctx.values.output;
  if (
    !targetPath ||
    extra.length ||
    typeof baselinePath !== "string" ||
    !baselinePath ||
    (output !== undefined && typeof output !== "string")
  )
    throw new CliError(
      "usage: drydock admit <package-lock.json> --baseline <trusted-package-lock.json> [--output NEW_FILE]",
      2,
    );
  if (!ctx.io.readFile || !ctx.io.writeNewFile)
    throw new CliError("admission requires the local Drydock CLI file interface");
  // Refuse existing output, including a prior receipt or either input file.
  if (output) {
    try {
      await ctx.io.readFile(output);
      throw new CliError("admission output already exists; choose a new receipt path", 2);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
        throw error;
    }
  }
  await checkActiveLock(ctx.io.readFile, targetPath);
  const started = ctx.io.now();
  const budget = { remaining: 1024 * 1024 * 1024 };
  const deadline = AbortSignal.timeout(8 * 60_000);
  const fetchEvidence = /** @type {typeof fetch} */ (
    (input, init) =>
      ctx.io.fetch(input, {
        ...init,
        signal: AbortSignal.any([deadline, ...(init?.signal ? [init.signal] : [])]),
      })
  );
  const manifestPath = targetPath.replace(/(?:package-lock|npm-shrinkwrap)\.json$/, "package.json");
  const [targetText, baselineText, manifestText] = await Promise.all([
    ctx.io.readFile(targetPath),
    ctx.io.readFile(baselinePath),
    ctx.io.readFile(manifestPath),
  ]);
  const target = parseAdmissionLock(targetText);
  const baseline = parseAdmissionLock(baselineText);
  validateAdmissionManifest(manifestText, targetText);
  const manifestHash = await textDigest(manifestText);
  const targetHash = await textDigest(targetText);
  const baselineHash = await textDigest(baselineText);
  const trusted = new Map([...baseline.values()].map((entry) => [identity(entry), entry]));
  /** @type {Map<string, {from: any, to: any}>} */
  const changes = new Map();
  /** @type {{package: string, version: string, reasons: string[]}[]} */
  const held = [];
  let trustedEntries = 0;
  for (const entry of target.values()) {
    if (trusted.has(identity(entry))) {
      trustedEntries++;
      continue;
    }
    const sameVersion = [...baseline.values()].some(
      (old) => old.name === entry.name && old.version === entry.version,
    );
    if (sameVersion) {
      held.push({
        package: entry.name,
        version: entry.version,
        reasons: ["same-version-artifact-changed"],
      });
      continue;
    }
    const atPath = baseline.get(entry.path);
    const candidates = [
      ...new Map(
        [...baseline.values()]
          .filter((old) => old.name === entry.name)
          .map((old) => [identity(old), old]),
      ).values(),
    ];
    const from =
      atPath?.name === entry.name ? atPath : candidates.length === 1 ? candidates[0] : null;
    if (!from) {
      held.push({
        package: entry.name,
        version: entry.version,
        reasons: [
          candidates.length ? "ambiguous-trusted-baseline" : "new-package-needs-manual-review",
        ],
      });
      continue;
    }
    changes.set(`${identity(from)}\n${identity(entry)}`, { from, to: entry });
  }
  if (changes.size > 40)
    throw new CliError("admission exceeds 40 changed artifacts; split the update");
  /** @type {any[]} */
  const reviewed = [];
  // Structural/new-package holds stop before any remote review. A partial
  // network run is unnecessary and must not look like an admitted graph.
  if (!held.length) {
    let index = 0;
    for (const { from, to } of changes.values()) {
      if (ctx.io.now() - started > 8 * 60_000)
        throw new CliError("admission exceeded its eight-minute budget");
      // Verify public accessibility and the locked bytes before exposing a name
      // to Drydock. No registry token/config is read or attached.
      const oldDigest = await verifyLockedArchive(fetchEvidence, from, budget);
      const newDigest = await verifyLockedArchive(fetchEvidence, to, budget);
      if (index++) await ctx.io.sleep(6100); // Public API permits ten pairs/minute.
      const diff = await readAdmissionDiff(fetchEvidence, ctx.baseUrl, from, to, budget);
      const reasons = admissionHolds(diff, from, to, oldDigest, newDigest);
      reviewed.push({
        package: to.name,
        from: from.version,
        to: to.version,
        fromSha256: oldDigest,
        toSha256: newDigest,
        integrity: to.integrity,
        analysisVersion: diff.analysisVersion,
        analyzedAt: diff.cachedAt,
        reasons,
      });
      if (reasons.length) held.push({ package: to.name, version: to.version, reasons });
    }
  }
  deadline.throwIfAborted();
  if (ctx.io.now() - started > 8 * 60_000)
    throw new CliError("admission exceeded its eight-minute budget");
  // Neither a moving trusted baseline nor a moving candidate is authorized.
  const [finalTarget, finalBaseline, finalManifest] = await Promise.all([
    ctx.io.readFile(targetPath),
    ctx.io.readFile(baselinePath),
    ctx.io.readFile(manifestPath),
  ]);
  if (
    (await textDigest(finalTarget)) !== targetHash ||
    (await textDigest(finalBaseline)) !== baselineHash ||
    (await textDigest(finalManifest)) !== manifestHash
  )
    throw new CliError("admission inputs changed during review; rerun against immutable files");
  await checkActiveLock(ctx.io.readFile, targetPath);
  deadline.throwIfAborted();
  if (ctx.io.now() - started > 8 * 60_000)
    throw new CliError("admission exceeded its eight-minute budget");
  const receipt = {
    schema: "drydock.npm-admission.v1",
    policy: ADMISSION_POLICY,
    status: held.length ? "held" : "admitted",
    createdAt: new Date(ctx.io.now()).toISOString(),
    packageJsonSha256: manifestHash,
    targetLockSha256: targetHash,
    trustedBaselineLockSha256: baselineHash,
    targetDependencyEntries: target.size,
    trustedEntries,
    reviewed,
    held,
    scope: "npm-package-lock-v2-v3-public-registry; caller-enforces-ordering; no-code-executed",
  };
  if (output) await ctx.io.writeNewFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
  ctx.io.stdout(`${terminalSafeJson(receipt)}\n`);
  return held.length ? 3 : 0;
}

/** @param {{name: string, version: string, resolved: string, integrity: string, declarations: Record<string, unknown>}} entry */
function identity(entry) {
  return `${entry.name}\n${entry.version}\n${entry.resolved}\n${entry.integrity}\n${JSON.stringify(entry.declarations)}`;
}

/** npm ci prefers shrinkwrap; a snapshot of a different graph cannot admit an install. @param {(path: string) => Promise<string>} readFile @param {string} targetPath */
async function checkActiveLock(readFile, targetPath) {
  const parts = targetPath.split(/[\\/]/);
  const name = parts.at(-1);
  if (name === "npm-shrinkwrap.json") return;
  if (name !== "package-lock.json")
    throw new CliError(
      "target must be the active package-lock.json or npm-shrinkwrap.json, not an arbitrary snapshot",
      2,
    );
  const sibling = `${targetPath.slice(0, targetPath.length - name.length)}npm-shrinkwrap.json`;
  try {
    await readFile(sibling);
    throw new CliError(
      "npm-shrinkwrap.json takes precedence; admit that active lockfile instead",
      2,
    );
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      throw error;
  }
}
