import type { CodePatternSet, FileRecord } from ".";
import type { PackageJsonSummary } from "./serialize";
import { isRecord } from "../platform/guards";
import { isNativeArtifactFile } from "./rules/binaries";
import { CONSUMER_INSTALL_LIFECYCLE_SCRIPTS } from "./rules/patterns";
import { isConsumerInstallScriptFile, matchDeterministicCodeCapabilities } from "./rules/scripts";

/**
 * Normalized per-side capability projection and cross-version delta.
 *
 * Capabilities are derived from the same pattern sets the deterministic rules
 * match, plus the manifest and the parser's file flags — but deliberately not
 * from the findings themselves. Rules run over the staged side only and
 * modulate severity by diff status, so a findings projection could never
 * answer the question this module exists for: what could the OLD version do,
 * what can the NEW one do, and what changed.
 *
 * Advisory, like the intent envelope: a capability set never feeds risk or
 * findings. It feeds the verdict payload, the review surfaces, AI-review
 * context, and (later) consumer-side policy.
 */
export type Capability =
  | "network"
  | "process"
  | "credentials"
  | "dynamicEval"
  | "native"
  | "installScripts"
  | "bin";

// Stable output order, so two projections of the same evidence are comparable
// byte-for-byte wherever they are serialized.
export const CAPABILITY_ORDER: readonly Capability[] = [
  "network",
  "process",
  "credentials",
  "dynamicEval",
  "native",
  "installScripts",
  "bin",
];

export interface CapabilitySet {
  capabilities: Capability[];
  /** Files whose full text was pattern-scanned. */
  inspectedFiles: number;
  /**
   * Files with an inspection gap a capability could hide in: bodies the
   * parser never retained (`content-skipped`), nonempty binary bodies that
   * have no text sample, minified scripts whose text sample is deliberately
   * skipped (`text-sample-skipped`, code-capable extensions only — a source
   * map or minified stylesheet cannot execute in the consumer's runtime), and
   * baseline bodies clipped at the baseline retention cap
   * (`baseline-truncated`, whose visible head is still scanned). Every set is
   * a lower bound; this counts the files where the bound has a hole.
   */
  uninspectedFiles: number;
  /** True when no file body or acquired artifact escaped inspection. */
  complete: boolean;
}

export interface CapabilityDelta {
  /** Null when there is no comparable baseline (first release, or skipped). */
  from: CapabilitySet | null;
  to: CapabilitySet;
  /** Capabilities the target side has and the baseline did not. */
  escalations: Capability[];
  /** Capabilities the baseline had and the target side no longer shows. */
  reductions: Capability[];
  /**
   * True only when both sides exist and both are complete. An empty
   * `escalations` with `confident: false` must never be rendered or evaluated
   * as "no escalation" — it means the comparison has uninspected bytes an
   * escalation could hide in.
   */
  confident: boolean;
}

// The minified-script shapes the parser refuses a text sample for
// (`shouldSkipTextSample` in tar-parser.js) that are still loadable as code.
// `.map` and `.min.css` are skipped there too but cannot execute in the
// consumer's runtime, so they are not counted as capability-coverage holes.
const CODE_CAPABLE_SKIPPED_SAMPLE_RE = /\.min\.(?:js|mjs|cjs)$/i;

// A file whose inspection has a hole a capability could hide in. The
// baseline-truncated head is still scanned below — the gap is its tail.
function hasInspectionGap(file: Pick<FileRecord, "path" | "size" | "flags">): boolean {
  if (file.flags.includes("content-skipped")) return true;
  if (file.flags.includes("baseline-truncated")) return true;
  // Binary bodies have no textSample, so the pattern matcher cannot say which
  // capabilities they contain. Native-format detection still contributes the
  // coarse `native` capability above, but it cannot prove the absence of
  // network, process, or credential behavior inside those bytes. Empty files
  // are also flagged `binary` by the parser and contain nothing to inspect.
  if (file.size > 0 && file.flags.includes("binary")) return true;
  return (
    file.flags.includes("text-sample-skipped") && CODE_CAPABLE_SKIPPED_SAMPLE_RE.test(file.path)
  );
}

export function projectCapabilities(
  files: ReadonlyArray<Pick<FileRecord, "path" | "size" | "textSample" | "flags">>,
  packageJson: PackageJsonSummary | null | undefined,
  codePatternSet?: CodePatternSet,
): CapabilitySet {
  const present = new Set<Capability>();
  let inspectedFiles = 0;
  let uninspectedFiles = 0;

  for (const file of files) {
    if (isNativeArtifactFile(file.path, file.flags)) present.add("native");
    const gap = hasInspectionGap(file);
    if (gap) uninspectedFiles++;
    if (typeof file.textSample !== "string" || !file.textSample) continue;
    const codeCapabilities = matchDeterministicCodeCapabilities(
      file.path,
      file.textSample,
      codePatternSet,
      {
        lifecycleScriptFile: isConsumerInstallScriptFile(
          file.path,
          packageJson?.scripts ?? {},
          packageJson?.implicitScripts ?? {},
        ),
      },
    );
    if (!codeCapabilities) continue;
    if (!gap) inspectedFiles++;
    if (!present.has("process") && codeCapabilities.processExecution.matched) {
      present.add("process");
    }
    if (!present.has("network") && codeCapabilities.networkAccess.matched) {
      present.add("network");
    }
    // A shell command that reaches the network is both things at once: it
    // spawns a process and it egresses. The rules split remote-shell out of
    // process-execution for scoring; the capability view folds it back into
    // the two primitives it is made of.
    if (
      (!present.has("network") || !present.has("process")) &&
      codeCapabilities.remoteShellCapability
    ) {
      present.add("network");
      present.add("process");
    }
    if (!present.has("dynamicEval") && codeCapabilities.dynamicEvaluation.matched) {
      present.add("dynamicEval");
    }
    if (!present.has("credentials") && codeCapabilities.credentialAccess.matched) {
      present.add("credentials");
    }
  }

  if (hasConsumerInstallScript(packageJson)) present.add("installScripts");
  if (hasBinEntry(packageJson?.bin)) present.add("bin");

  return {
    capabilities: sortCapabilities(present),
    inspectedFiles,
    uninspectedFiles,
    complete: uninspectedFiles === 0,
  };
}

export function diffCapabilities(from: CapabilitySet | null, to: CapabilitySet): CapabilityDelta {
  if (!from) {
    return { from: null, to, escalations: [], reductions: [], confident: false };
  }
  const fromSet = new Set(from.capabilities);
  const toSet = new Set(to.capabilities);
  return {
    from,
    to,
    escalations: to.capabilities.filter((capability) => !fromSet.has(capability)),
    reductions: from.capabilities.filter((capability) => !toSet.has(capability)),
    confident: from.complete && to.complete,
  };
}

/**
 * Re-validate a persisted delta (summaryJson blob, report export, cached diff
 * payload). Returns null for anything that predates the projection or was
 * stored malformed, like `normalizeIntentEnvelope`.
 */
export function normalizeCapabilityDelta(value: unknown): CapabilityDelta | null {
  if (!isRecord(value)) return null;
  const to = normalizeCapabilitySet(value.to);
  if (!to) return null;
  const from =
    value.from === null || value.from === undefined ? null : normalizeCapabilitySet(value.from);
  if (value.from !== null && value.from !== undefined && !from) return null;
  const escalations = normalizeCapabilityList(value.escalations);
  const reductions = normalizeCapabilityList(value.reductions);
  if (!escalations || !reductions) return null;
  const normalized = diffCapabilities(from, to);
  if (
    !sameCapabilityList(escalations, normalized.escalations) ||
    !sameCapabilityList(reductions, normalized.reductions)
  ) {
    return null;
  }
  return normalized;
}

function normalizeCapabilitySet(value: unknown): CapabilitySet | null {
  if (!isRecord(value)) return null;
  const capabilities = normalizeCapabilityList(value.capabilities);
  if (!capabilities) return null;
  const inspectedFiles = nonNegativeInteger(value.inspectedFiles);
  const uninspectedFiles = nonNegativeInteger(value.uninspectedFiles);
  if (inspectedFiles === null || uninspectedFiles === null) return null;
  return {
    capabilities,
    inspectedFiles,
    uninspectedFiles,
    complete: uninspectedFiles === 0,
  };
}

function normalizeCapabilityList(value: unknown): Capability[] | null {
  if (!Array.isArray(value)) return null;
  const present = new Set<Capability>();
  for (const entry of value) {
    if (!CAPABILITY_ORDER.includes(entry as Capability)) return null;
    present.add(entry as Capability);
  }
  return sortCapabilities(present);
}

function sortCapabilities(present: ReadonlySet<Capability>): Capability[] {
  return CAPABILITY_ORDER.filter((capability) => present.has(capability));
}

function sameCapabilityList(left: readonly Capability[], right: readonly Capability[]): boolean {
  return (
    left.length === right.length && left.every((capability, index) => capability === right[index])
  );
}

function hasConsumerInstallScript(packageJson: PackageJsonSummary | null | undefined): boolean {
  if (!packageJson) return false;
  // `gypfile` is npm's implicit `node-gyp rebuild` install hook — an install
  // script the manifest never spells out (install-script.implicit-node-gyp).
  if (packageJson.gypfile === true) return true;
  for (const scripts of [packageJson.scripts, packageJson.implicitScripts]) {
    if (!scripts) continue;
    for (const name of CONSUMER_INSTALL_LIFECYCLE_SCRIPTS) {
      if (typeof scripts[name] === "string" && scripts[name].trim()) return true;
    }
  }
  return false;
}

function hasBinEntry(bin: PackageJsonSummary["bin"]): boolean {
  if (typeof bin === "string") return bin.trim().length > 0;
  if (isRecord(bin)) return Object.keys(bin).length > 0;
  return false;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
