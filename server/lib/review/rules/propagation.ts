import { firstMatchingCodeLine } from "../../platform/text-utils";
import type { Finding } from "..";
import { firstJsonPropertyLine, tag } from "./helpers";
import { changedPrefix, type RuleContext } from "./context";
import { isDocumentationPath, isPythonMetadataPath, isTypeDeclarationPath } from "./file-types";
import { normalizeCodeForScanning } from "./normalize";
import { CONSUMER_INSTALL_LIFECYCLE_SCRIPTS } from "./patterns";
import { normalizeReachabilityPath } from "./reachability";

// Self-propagation: a payload that reaches the *next* artifact instead of only
// the machine it landed on. The other families answer "what can this package
// do to the consumer"; this one answers "can this package republish itself".
//
// Both signals are ordinary developer actions somewhere: a release CLI runs
// `npm publish`, a patch tool writes into `node_modules`. What has no benign
// reading is doing either one *during someone else's install*, so the whole
// family gates on `ctx.installReachable` rather than trying to separate the
// tools from the worm by pattern. That gate is also the coverage limit: a
// payload that propagates when the package is later imported, rather than when
// it is installed, is not modelled here.
export function propagationFindings(ctx: RuleContext): Finding[] {
  const findings = lifecycleCommandFindings(ctx);
  if (!ctx.installReachable.size) return findings;

  for (const file of ctx.files) {
    if (isDocumentationPath(file.path) || isTypeDeclarationPath(file.path)) continue;
    if (ctx.codePatternSet === "python" && isPythonMetadataPath(file.path)) continue;
    if (!ctx.installReachable.has(normalizeReachabilityPath(file.path))) continue;

    const sample = file.textSample || "";
    if (!sample) continue;
    const normalized = ctx.codePatternSet === "python" ? sample : normalizeCodeForScanning(sample);
    findings.push(
      ...propagationSourceFindings(ctx, {
        file: file.path,
        sample,
        normalized,
        prefix: changedPrefix(ctx, file.path),
      }),
    );
  }
  return findings;
}

interface PropagationSource {
  file: string;
  sample: string;
  normalized: string;
  prefix: string;
  line?: number;
}

function lifecycleCommandFindings(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];
  const file = ctx.packageJsonFile?.path ?? "package.json";
  for (const script of CONSUMER_INSTALL_LIFECYCLE_SCRIPTS) {
    const command = ctx.scripts[script];
    if (!command || ctx.implicitScripts[script] === command) continue;
    findings.push(
      ...propagationSourceFindings(ctx, {
        file,
        sample: command,
        normalized: ctx.codePatternSet === "python" ? command : normalizeCodeForScanning(command),
        prefix: changedPrefix(ctx, file),
        line: firstJsonPropertyLine(ctx.packageJsonFile?.textSample, script, command),
      }),
    );
  }
  return findings;
}

function propagationSourceFindings(ctx: RuleContext, source: PropagationSource): Finding[] {
  const findings: Finding[] = [];
  const publish = matchLine(ctx.patterns.registryPublish, source.sample, source.normalized);
  if (publish) {
    findings.push(
      tag("propagationRegistryPublish", {
        severity: "critical",
        file: source.file,
        line: source.line ?? publish.line,
        evidence: `${source.prefix}registry publish on the consumer install path`,
        reason:
          "code that runs during a consumer's install invokes a registry publish, so installing this package can publish packages under whatever credentials the machine holds: the self-propagation step that turns a single compromised release into a worm",
        ...(publish.obfuscated ? { obfuscated: true } : {}),
      }),
    );
  }

  const installRoot = matchLine(ctx.patterns.installRootPath, source.sample, source.normalized);
  const write = matchLine(ctx.patterns.installWrite, source.sample, source.normalized);
  if (installRoot && write) {
    findings.push(
      tag("propagationPackageMutation", {
        severity: "high",
        file: source.file,
        line: source.line ?? installRoot.line,
        evidence: `${source.prefix}install-time write into the dependency install root`,
        reason:
          "code that runs during a consumer's install writes into the directory the package manager unpacks dependencies into, so it can add hooks or payloads to packages the consumer already trusts",
        ...(installRoot.obfuscated || write.obfuscated ? { obfuscated: true } : {}),
      }),
    );
  }
  return findings;
}

// Matches the capability rules' contract: scan the literal text first so the
// evidence line points at real source, fall back to the constant-folded text,
// and remember when only the folded text matched — assembling `npm pub` +
// `lish` at runtime is itself a malice signal the risk layer reads.
function matchLine(
  patterns: RegExp[],
  sample: string,
  normalized: string,
): { line: number | undefined; obfuscated: boolean } | null {
  const line = firstMatchingCodeLine(sample, patterns);
  if (line !== undefined) return { line, obfuscated: false };
  if (normalized === sample) return null;
  const normalizedLine = firstMatchingCodeLine(normalized, patterns);
  return normalizedLine === undefined ? null : { line: normalizedLine, obfuscated: true };
}
