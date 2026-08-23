import {
  deterministicFindings,
  packageJsonDiffFindings,
  tarSuspiciousEntryFindings,
  type DiffEntry,
  type Finding,
  type PackageJsonDiff,
} from "../../review";
import { firstJsonPropertyLine } from "../../review/rules/helpers";
import type { AcquiredArtifact } from "../package-adapter";
import {
  browserExtensionIdentity,
  findBrowserManifestFile,
  parseBrowserExtensionManifest,
} from "./manifest";
import {
  BROWSER_RULE_IDS,
  BROWSER_RULES_VERSION,
  type BrowserAdapterDetails,
  type BrowserExtensionManifest,
} from "./types";

const PRIVILEGED_PERMISSIONS = new Set([
  "debugger",
  "management",
  "nativeMessaging",
  "privacy",
  "proxy",
  "webRequestBlocking",
]);
const ALL_URL_PATTERNS = new Set(["<all_urls>", "*://*/*", "https://*/*", "http://*/*"]);

export function buildBrowserFindings(args: {
  staged: AcquiredArtifact;
  details: BrowserAdapterDetails;
  fileDiff: DiffEntry[];
  manifestDiff: PackageJsonDiff;
  stagedManifestText: string | null;
}): Finding[] {
  const extensionManifest = parseBrowserExtensionManifest(args.staged.files).manifest;
  return [
    ...deterministicFindings(args.staged.files, args.fileDiff, args.staged.manifest, {
      codePatternSet: "javascript",
    }),
    ...packageJsonDiffFindings(args.manifestDiff, args.stagedManifestText),
    ...tarSuspiciousEntryFindings(args.staged.suspiciousTarEntries, { fileDiff: args.fileDiff }),
    ...browserManifestFindings(args.details, extensionManifest, args.staged.files),
  ];
}

function browserManifestFindings(
  details: BrowserAdapterDetails,
  manifest: BrowserExtensionManifest,
  files: AcquiredArtifact["files"],
): Finding[] {
  const findings: Finding[] = [];
  const manifestFile = findBrowserManifestFile(files);
  const identity = browserExtensionIdentity(manifest);
  const mismatches: string[] = [];
  if (details.manifest.package !== identity) {
    mismatches.push(`release package ${details.manifest.package} != manifest.json ${identity}`);
  }
  if (details.manifest.version !== manifest.version) {
    mismatches.push(
      `release version ${details.manifest.version} != manifest.json ${manifest.version}`,
    );
  }
  if (mismatches.length) {
    findings.push(
      browserTag("metadataMismatch", {
        severity: "critical",
        file: "manifest.json",
        evidence: mismatches.join("; "),
        reason:
          "the reviewed archive identity does not match its extension manifest, so the release target cannot be trusted",
      }),
    );
  }

  for (const permission of unique([...manifest.permissions, ...manifest.optionalPermissions])) {
    if (!PRIVILEGED_PERMISSIONS.has(permission)) continue;
    findings.push(
      browserTag("privilegedPermission", {
        severity: "high",
        file: "manifest.json",
        line: firstJsonPropertyLine(manifestFile?.textSample, "permissions", permission),
        evidence: `extension requests privileged permission ${permission}`,
        reason:
          "this permission grants control over browser or host capabilities that can materially expand the impact of compromised extension code",
      }),
    );
  }

  const broadHost = unique([
    ...manifest.hostPermissions,
    ...manifest.optionalHostPermissions,
    ...manifest.permissions,
  ]).find(isAllUrlsPattern);
  if (broadHost) {
    findings.push(
      browserTag("broadHostAccess", {
        severity: "high",
        file: "manifest.json",
        line: firstJsonPropertyLine(manifestFile?.textSample, "host_permissions", broadHost),
        evidence: `extension requests host access ${broadHost}`,
        reason:
          "access to every site lets extension code read or alter sensitive browser content across unrelated origins",
      }),
    );
  }

  const broadContentScript = manifest.contentScriptMatches.find(isAllUrlsPattern);
  if (broadContentScript) {
    findings.push(
      browserTag("broadContentScript", {
        severity: "high",
        file: "manifest.json",
        line: firstJsonPropertyLine(manifestFile?.textSample, "matches", broadContentScript),
        evidence: `content script runs on ${broadContentScript}`,
        reason:
          "a content script injected into every site can observe or modify sensitive page data before the user invokes the extension",
      }),
    );
  }

  const externalMatch = manifest.externallyConnectableMatches.find(isBroadExternalOrigin);
  if (externalMatch) {
    findings.push(
      browserTag("externallyConnectable", {
        severity: "high",
        file: "manifest.json",
        line: firstJsonPropertyLine(
          manifestFile?.textSample,
          "externally_connectable",
          externalMatch,
        ),
        evidence: `external pages may connect from ${externalMatch}`,
        reason:
          "a broad externally_connectable origin lets arbitrary sites send messages into privileged extension code",
      }),
    );
  }

  const unsafeCsp = unsafeExtensionCspEvidence(manifest.contentSecurityPolicy);
  if (unsafeCsp) {
    findings.push(
      browserTag("unsafeExtensionCsp", {
        severity: "high",
        file: "manifest.json",
        line: firstJsonPropertyLine(manifestFile?.textSample, "content_security_policy"),
        evidence: unsafeCsp,
        reason:
          "an extension CSP that permits dynamic or remotely hosted script weakens the reviewed-archive boundary",
      }),
    );
  }

  return findings;
}

function isAllUrlsPattern(value: string): boolean {
  return ALL_URL_PATTERNS.has(value.trim().toLowerCase());
}

function isBroadExternalOrigin(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    isAllUrlsPattern(normalized) || normalized === "https://*/*" || normalized === "http://*/*"
  );
}

function unsafeExtensionCspEvidence(value: string | null): string | null {
  if (!value) return null;
  if (/['"]unsafe-eval['"]/i.test(value)) return "extension CSP permits unsafe-eval";
  const scriptSource = /(?:^|;)\s*script-src\s+([^;]+)/i.exec(value)?.[1] ?? "";
  const remote = scriptSource
    .split(/\s+/)
    .find((source) => source === "*" || /^https?:$/i.test(source) || /^https?:\/\//i.test(source));
  return remote ? `extension CSP permits remote script source ${remote}` : null;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function browserTag(
  rule: keyof typeof BROWSER_RULE_IDS,
  finding: Omit<Finding, "ruleId" | "ruleVersion">,
): Finding {
  return { ...finding, ruleId: BROWSER_RULE_IDS[rule], ruleVersion: BROWSER_RULES_VERSION };
}
