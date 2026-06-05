import { hasImplicitNodeGypInstall } from "../tar-parser.js";
import { firstMatchingLine } from "../text-utils";
import type { Finding } from "../review";
import { LIFECYCLE_SCRIPTS } from "./patterns";
import { firstJsonPropertyLine, tag } from "./helpers";
import {
  changedPrefix,
  fileReachability,
  type FileReachability,
  type RuleContext,
} from "./context";
import { isDocumentationPath } from "./file-types";
import { normalizeCodeForScanning } from "./normalize";

// Install lifecycle hooks and in-file code-execution capability: the scripts and
// code paths that run on, or are pulled in by, a consumer install.
export function scriptFindings(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];

  const implicitNodeGyp =
    ctx.implicitScripts.install === "node-gyp rebuild" ||
    hasImplicitNodeGypInstall(ctx.files, ctx.packageJson);
  if (implicitNodeGyp) {
    findings.push(
      tag("installScriptImplicitNodeGyp", {
        severity: "high",
        file: ctx.rootGypFile?.path ?? ctx.packageJsonFile?.path ?? "package.json",
        line: ctx.rootGypFile
          ? 1
          : firstJsonPropertyLine(ctx.packageJsonFile?.textSample, "gypfile"),
        evidence: "implicit install: node-gyp rebuild",
        reason: ctx.rootGypFile
          ? "npm defaults install to node-gyp rebuild when a root *.gyp file exists and no install/preinstall script or gypfile=false is declared"
          : "npm staged metadata reports the default node-gyp install hook; the source root had a *.gyp file even if that file is not present in the packed tarball",
      }),
    );
  }

  for (const script of LIFECYCLE_SCRIPTS) {
    if (!ctx.scripts[script] || ctx.implicitScripts[script] === ctx.scripts[script]) continue;
    findings.push(
      tag(script === "preinstall" ? "installScriptPreinstall" : "installScript", {
        severity: script === "preinstall" ? "critical" : "high",
        file: ctx.packageJsonFile?.path ?? "package.json",
        line: firstJsonPropertyLine(ctx.packageJsonFile?.textSample, script, ctx.scripts[script]),
        evidence: `${script}: ${ctx.scripts[script]}`,
        reason: "install lifecycle hooks execute on consumer machines",
      }),
    );
  }

  for (const file of ctx.files) {
    if (isDocumentationPath(file.path)) continue;

    const sample = file.textSample || "";
    // Constant-fold runtime-assembled identifiers (`'chi'+'ld_process'`,
    // `globalThis['re'+'quire']`) so the literal regex set sees them. Matching
    // both raw and normalized text means folding can only add detections, never
    // drop one a literal scan already finds. JavaScript only for now; the
    // normalizer is JS-flavored and Python evasion is out of scope.
    const normalized = ctx.codePatternSet === "python" ? sample : normalizeCodeForScanning(sample);
    const prefix = changedPrefix(ctx, file.path);
    const changed = ctx.diffByPath.get(file.path)?.status;
    const reachability = fileReachability(ctx, file.path);
    const lifecycleScriptFile = reachability === "install";

    const processExecution = matchCategory(ctx.patterns.processExecution, sample, normalized);
    const networkAccess = matchCategory(ctx.patterns.networkAccess, sample, normalized);
    const dynamicEvaluation = matchCategory(ctx.patterns.dynamicEvaluation, sample, normalized);
    const credentialAccess = matchCategory(ctx.patterns.credentialAccess, sample, normalized);
    const adjacentExecutionRisk =
      processExecution.matched || dynamicEvaluation.matched || credentialAccess.matched;

    if (processExecution.matched) {
      const severity = processExecutionSeverity(ctx, reachability, changed);
      findings.push(
        tag("codeProcessExecution", {
          severity,
          file: file.path,
          line: processExecution.line,
          evidence: `${prefix}process or shell execution`,
          reason:
            severity === "high"
              ? "package may execute arbitrary commands"
              : "process or shell execution in a file the manifest neither runs on install nor exposes as an entrypoint; commonly local build tooling, so weighted below release significance",
        }),
      );
    }
    if (
      (changed !== "unchanged" || lifecycleScriptFile || adjacentExecutionRisk) &&
      networkAccess.matched
    ) {
      findings.push(
        tag("codeNetworkAccess", {
          severity: networkAccessSeverity(changed, lifecycleScriptFile, adjacentExecutionRisk),
          file: file.path,
          line: networkAccess.line,
          evidence: `${prefix}network-capable code path`,
          reason:
            "unexpected network access in package code can be used for exfiltration or staged payload retrieval",
        }),
      );
    }
    if (dynamicEvaluation.matched) {
      findings.push(
        tag("codeDynamicEvaluation", {
          severity: changed === "added" ? "high" : "medium",
          file: file.path,
          line: dynamicEvaluation.line,
          evidence: `${prefix}dynamic code or obfuscation primitive`,
          reason: "common malware and obfuscation technique",
        }),
      );
    }
    if (credentialAccess.matched) {
      findings.push(
        tag("codeCredentialAccess", {
          severity: changed === "added" ? "high" : "medium",
          file: file.path,
          line: credentialAccess.line,
          evidence: `${prefix}secret/environment access`,
          reason: "package may read credentials from the install environment",
        }),
      );
    }
  }

  return findings;
}

// Match a capability category against the raw sample and, only if that misses,
// the constant-folded text. Prefers the raw line so evidence keeps pointing at
// the literal match when one exists; folding preserves line numbers, so the
// normalized line still maps to the real source line.
function matchCategory(
  patterns: RegExp[],
  sample: string,
  normalized: string,
): { matched: boolean; line: number | undefined } {
  const line = firstMatchingLine(sample, patterns);
  if (line !== undefined) return { matched: true, line };
  if (normalized !== sample) {
    const normalizedLine = firstMatchingLine(normalized, patterns);
    if (normalizedLine !== undefined) return { matched: true, line: normalizedLine };
  }
  return { matched: false, line: undefined };
}

function networkAccessSeverity(
  changed: RuleContext["diff"][number]["status"] | undefined,
  lifecycleScriptFile: boolean,
  adjacentExecutionRisk: boolean,
): Finding["severity"] {
  return changed === "added" && (lifecycleScriptFile || adjacentExecutionRisk) ? "high" : "medium";
}

// Weight process/shell execution by where the code sits in the package, so a
// local build helper that legitimately shells out is not scored the same as an
// install hook. Install hooks (auto-run on `npm install`) and declared
// entrypoints (run when the consumer imports/invokes the package) keep full
// weight; an unreferenced build/source file is recorded but weighted below
// release significance, with diff novelty splitting newly-introduced from
// pre-existing capability. Co-occurring network/credential/eval capability still
// escalates through its own rule, so a real dropper does not slip through.
function processExecutionSeverity(
  ctx: RuleContext,
  reachability: FileReachability,
  changed: RuleContext["diff"][number]["status"] | undefined,
): Finding["severity"] {
  // PyPI install reachability is modeled by the adapter's setup.py / startup-hook
  // rules rather than the npm manifest map, so the reachability tiers above do
  // not apply; keep the historical high severity for Python evidence.
  if (ctx.codePatternSet === "python") return "high";
  if (reachability !== "unreferenced") return "high";
  return changed === "unchanged" ? "info" : "low";
}
