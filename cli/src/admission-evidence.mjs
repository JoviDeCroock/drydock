// @ts-check
import { admissionDeclarations, admissionPeerMeta } from "./admission-manifest.mjs";
import { CliError } from "./client.mjs";
import { hex, record, strongestIntegrity } from "./admission-lockfile.mjs";

export const ADMISSION_POLICY = "npm-admission.v1";
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

/** Bounded credential-free reads. Package bytes are hashed only, never extracted or executed. @param {typeof fetch} fetcher @param {string} url @param {number} limit @param {{remaining: number}} budget */
async function boundedRead(fetcher, url, limit, budget) {
  const response = await fetcher(url, {
    method: "GET",
    redirect: "manual",
    credentials: "omit",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: "application/octet-stream, application/json", "x-drydock-client": "cli" },
  });
  if (!response.ok || response.status >= 300) {
    await response.body?.cancel();
    throw new CliError(
      `admission evidence unavailable (HTTP ${response.status}); no install is authorized`,
    );
  }
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel();
    throw new CliError("admission response exceeds its byte budget");
  }
  if (!response.body) throw new CliError("admission evidence has no response body");
  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      budget.remaining -= value.byteLength;
      if (budget.remaining < 0)
        throw new CliError("admission exceeds its total one-GiB download budget");
      if (size > limit) throw new CliError("admission response exceeds its byte budget");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** @param {typeof fetch} fetcher @param {{resolved: string, integrity: string}} entry @param {{remaining: number}} budget */
export async function verifyLockedArchive(fetcher, entry, budget) {
  const bytes = await boundedRead(fetcher, entry.resolved, MAX_ARCHIVE_BYTES, budget);
  const pin = strongestIntegrity(entry.integrity);
  const digest = new Uint8Array(await crypto.subtle.digest(`SHA-${pin.algorithm.slice(3)}`, bytes));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  if (btoa(binary) !== pin.digest)
    throw new CliError("downloaded bytes do not match lockfile integrity; admission blocked");
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/** @param {typeof fetch} fetcher @param {string} origin @param {{name: string, version: string}} from @param {{name: string, version: string}} to @param {{remaining: number}} budget */
export async function readAdmissionDiff(fetcher, origin, from, to, budget) {
  const params = new URLSearchParams({
    ecosystem: "npm",
    package: to.name,
    from: from.version,
    to: to.version,
  });
  const bytes = await boundedRead(
    fetcher,
    `${origin}/api/public/v1/package-diff?${params}`,
    MAX_RESPONSE_BYTES,
    budget,
  );
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new CliError("Drydock returned invalid admission JSON");
  }
}

/** Missing evidence is never an empty finding list. @param {any} diff @param {{name: string, version: string}} from @param {{name: string, version: string, declarations: Record<string, unknown>}} to @param {string} oldDigest @param {string} newDigest @returns {string[]} */
export function admissionHolds(diff, from, to, oldDigest, newDigest) {
  if (
    !record(diff) ||
    diff.ecosystem !== "npm" ||
    diff.packageName !== to.name ||
    diff.fromVersion !== from.version ||
    diff.toVersion !== to.version ||
    !record(diff.fromPackageJson) ||
    !record(diff.toPackageJson) ||
    diff.fromPackageJson.name !== from.name ||
    diff.fromPackageJson.version !== from.version ||
    diff.toPackageJson.name !== to.name ||
    diff.toPackageJson.version !== to.version
  ) {
    throw new CliError("Drydock response identity does not match the exact locked artifacts");
  }
  if (
    diff.artifactDigests?.from?.sha256 !== oldDigest ||
    diff.artifactDigests?.to?.sha256 !== newDigest
  )
    throw new CliError("Drydock reviewed different or unbound archive bytes");
  if (
    typeof diff.analysisVersion !== "string" ||
    !diff.analysisVersion ||
    typeof diff.cachedAt !== "string" ||
    !Number.isFinite(Date.parse(diff.cachedAt)) ||
    !Array.isArray(diff.notices) ||
    typeof diff.textSamplesOmitted !== "boolean" ||
    !Array.isArray(diff.diff) ||
    !Array.isArray(diff.findings) ||
    !record(diff.risk) ||
    !["low", "medium", "high", "critical"].includes(diff.risk.releaseRisk) ||
    !record(diff.packageJsonDiff)
  ) {
    throw new CliError("Drydock response lacks required coverage, risk, or version evidence");
  }
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (
      JSON.stringify(admissionDeclarations(diff.toPackageJson[section])) !==
      JSON.stringify(to.declarations[section])
    )
      throw new CliError(
        "reviewed package dependency declarations differ from the target lock node; complete graph is unproven",
      );
  }
  if (
    JSON.stringify(admissionPeerMeta(diff.toPackageJson.peerDependenciesMeta)) !==
    JSON.stringify(to.declarations.peerDependenciesMeta)
  )
    throw new CliError("reviewed package optional peer metadata differs from the target lock node");
  const holds = new Set();
  if (["high", "critical"].includes(diff.risk.releaseRisk)) holds.add("release-risk");
  if (diff.notices.length || diff.textSamplesOmitted) holds.add("incomplete-coverage");
  for (const finding of diff.findings) {
    if (
      !record(finding) ||
      !["info", "low", "medium", "high", "critical"].includes(finding.severity) ||
      typeof finding.releaseDelta !== "boolean"
    )
      throw new CliError("Drydock returned malformed finding attribution");
    if (finding.releaseDelta && ["high", "critical"].includes(finding.severity))
      holds.add("release-risk");
  }
  for (const file of diff.diff) {
    if (
      !record(file) ||
      typeof file.path !== "string" ||
      !["added", "modified", "removed", "unchanged"].includes(file.status) ||
      !Array.isArray(file.flags)
    )
      throw new CliError("Drydock returned malformed file coverage");
    if (
      file.status !== "removed" &&
      (/(^|\/)npm-shrinkwrap\.json$/.test(file.path) || /(^|\/)node_modules\//.test(file.path))
    )
      holds.add("unsupported-nested-install-graph");
    if (!["added", "modified"].includes(file.status)) continue;
    if (file.flags.some((/** @type {unknown} */ flag) => typeof flag !== "string"))
      throw new CliError("Drydock returned invalid coverage flags");
    if (/\.(?:node|so|dll|dylib|exe|wasm)$/i.test(file.path))
      holds.add("uninspected-or-native-content");
    if (
      file.flags.some((/** @type {string} */ flag) =>
        /skipped|omitted|truncated|binary|native|minified/.test(flag),
      )
    )
      holds.add("uninspected-or-native-content");
  }
  for (const section of ["scripts", "dependencies", "bin"]) {
    const changes = diff.packageJsonDiff[section];
    if (!Array.isArray(changes))
      throw new CliError("Drydock response lacks capability-change evidence");
    for (const entry of changes) {
      if (
        !record(entry) ||
        typeof entry.key !== "string" ||
        !entry.key ||
        !["added", "modified", "removed"].includes(entry.status)
      )
        throw new CliError("Drydock returned malformed capability evidence");
      if (!["added", "modified"].includes(entry.status)) continue;
      if (section === "scripts" && ["preinstall", "install", "postinstall"].includes(entry.key))
        holds.add("install-script-changed");
      if (section === "dependencies" && entry.status === "added" && !entry.previouslyDeclared)
        holds.add("dependency-added");
      if (section === "bin" && entry.status === "added") holds.add("bin-command-added");
    }
  }
  return [...holds];
}
