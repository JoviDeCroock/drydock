import { hasImplicitNodeGypInstall } from "../tar-parser.js";
import { firstMatchingLine } from "../text-utils";
import type { Finding } from "../review";
import { LIFECYCLE_SCRIPTS } from "./patterns";
import { firstJsonPropertyLine, tag } from "./helpers";
import { changedPrefix, type RuleContext } from "./context";

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
    const sample = file.textSample || "";
    const prefix = changedPrefix(ctx, file.path);
    const changed = ctx.diffByPath.get(file.path)?.status;

    if (ctx.patterns.processExecution.some((pattern) => pattern.test(sample))) {
      findings.push(
        tag("codeProcessExecution", {
          severity: "high",
          file: file.path,
          line: firstMatchingLine(sample, ctx.patterns.processExecution),
          evidence: `${prefix}process or shell execution`,
          reason: "package may execute arbitrary commands",
        }),
      );
    }
    if (ctx.patterns.networkAccess.some((pattern) => pattern.test(sample))) {
      findings.push(
        tag("codeNetworkAccess", {
          severity: changed === "added" ? "high" : "medium",
          file: file.path,
          line: firstMatchingLine(sample, ctx.patterns.networkAccess),
          evidence: `${prefix}network-capable code path`,
          reason:
            "unexpected network access in package code can be used for exfiltration or staged payload retrieval",
        }),
      );
    }
    if (ctx.patterns.dynamicEvaluation.some((pattern) => pattern.test(sample))) {
      findings.push(
        tag("codeDynamicEvaluation", {
          severity: changed === "added" ? "high" : "medium",
          file: file.path,
          line: firstMatchingLine(sample, ctx.patterns.dynamicEvaluation),
          evidence: `${prefix}dynamic code or obfuscation primitive`,
          reason: "common malware and obfuscation technique",
        }),
      );
    }
    if (ctx.patterns.credentialAccess.some((pattern) => pattern.test(sample))) {
      findings.push(
        tag("codeCredentialAccess", {
          severity: changed === "added" ? "high" : "medium",
          file: file.path,
          line: firstMatchingLine(sample, ctx.patterns.credentialAccess),
          evidence: `${prefix}secret/environment access`,
          reason: "package may read credentials from the install environment",
        }),
      );
    }
  }

  return findings;
}
