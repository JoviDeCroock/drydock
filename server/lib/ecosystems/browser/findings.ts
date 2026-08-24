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
  browserExtensionCandidateName,
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
  "bookmarks",
  "browserSettings",
  "browsingData",
  "certificateProvider",
  "clipboardRead",
  "clipboardWrite",
  "contentSettings",
  "contextualIdentities",
  "cookies",
  "debugger",
  "declarativeNetRequest",
  "declarativeNetRequestFeedback",
  "declarativeNetRequestWithHostAccess",
  "declarativeWebRequest",
  "desktopCapture",
  "dns",
  "documentScan",
  "downloads",
  "downloads.open",
  "downloads.ui",
  "enterprise.deviceAttributes",
  "enterprise.hardwarePlatform",
  "enterprise.networkingAttributes",
  "enterprise.platformKeys",
  "fileBrowserHandler",
  "fileSystemProvider",
  "geolocation",
  "history",
  "identity",
  "identity.email",
  "idle",
  "management",
  "nativeMessaging",
  "pageCapture",
  "pkcs11",
  "platformKeys",
  "privacy",
  "printerProvider",
  "printing",
  "printingMetrics",
  "processes",
  "proxy",
  "scripting",
  "search",
  "sessions",
  "system.cpu",
  "system.display",
  "system.memory",
  "system.storage",
  "tabCapture",
  "tabHide",
  "tabs",
  "topSites",
  "userScripts",
  "vpnProvider",
  "webAuthenticationProxy",
  "webNavigation",
  "webRequest",
  "webRequestAuthProvider",
  "webRequestBlocking",
  "webRequestFilterResponse",
  "webRequestFilterResponse.serviceWorkerScript",
]);
const ALL_URL_PATTERNS = new Set([
  "<all_urls>",
  "*://*/",
  "*://*/*",
  "https://*/",
  "https://*/*",
  "http://*/",
  "http://*/*",
]);

const EXECUTABLE_CSP_DIRECTIVE_CHAINS = [
  ["script-src", "default-src"],
  ["script-src-elem", "script-src", "default-src"],
  ["worker-src", "child-src", "script-src", "default-src"],
] as const;

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
      consumerEntrypointPaths: [
        ...extensionManifest.backgroundEntrypoints,
        ...extensionManifest.contentScriptEntrypoints,
        ...extensionManifest.extensionPageEntrypoints,
      ],
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
  const candidateName = browserExtensionCandidateName(manifest);
  const mismatches: string[] = [];
  if (details.manifest.package !== candidateName) {
    mismatches.push(
      `release package ${details.manifest.package} != manifest.json ${candidateName}`,
    );
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

  const permissions = uniqueManifestValues([
    ["permissions", manifest.permissions],
    ["optional_permissions", manifest.optionalPermissions],
  ]);
  for (const { value: permission, property } of permissions) {
    if (!PRIVILEGED_PERMISSIONS.has(permission)) continue;
    findings.push(
      browserTag("privilegedPermission", {
        severity: "high",
        file: "manifest.json",
        line: firstJsonPropertyLine(manifestFile?.textSample, property, permission),
        evidence: `extension requests privileged permission ${permission}`,
        reason:
          "this permission grants control over browser or host capabilities that can materially expand the impact of compromised extension code",
      }),
    );
  }

  const broadHost = uniqueManifestValues([
    ["host_permissions", manifest.hostPermissions],
    ["optional_host_permissions", manifest.optionalHostPermissions],
    ["permissions", manifest.permissions],
    ["optional_permissions", manifest.optionalPermissions],
  ]).find(({ value }) => isAllUrlsPattern(value));
  if (broadHost) {
    findings.push(
      browserTag("broadHostAccess", {
        severity: "high",
        file: "manifest.json",
        line: firstJsonPropertyLine(manifestFile?.textSample, broadHost.property, broadHost.value),
        evidence: `extension requests host access ${broadHost.value}`,
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
  const directives = parseCspDirectives(value);
  const inspected = new Set<string>();
  for (const chain of EXECUTABLE_CSP_DIRECTIVE_CHAINS) {
    const directive = chain.find((name) => directives.has(name));
    if (!directive || inspected.has(directive)) continue;
    inspected.add(directive);
    const sources = directives.get(directive) ?? [];
    const nonPackageSource = sources.find(isNonPackageScriptSource);
    if (nonPackageSource) {
      return `extension CSP ${directive} permits non-package script source ${nonPackageSource}`;
    }
  }
  return null;
}

function parseCspDirectives(value: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const segment of value.split(";")) {
    const [rawName, ...sources] = segment.trim().split(/\s+/);
    if (!rawName) continue;
    const name = rawName.toLowerCase();
    if (!directives.has(name)) directives.set(name, sources.filter(Boolean));
  }
  return directives;
}

function isNonPackageScriptSource(source: string): boolean {
  const normalized = source.trim().toLowerCase();
  if (!normalized || normalized === "'self'" || normalized === "'none'") return false;
  if (/^'(?:nonce-|sha(?:256|384|512)-)/.test(normalized)) return false;
  // Other quoted tokens are CSP keywords rather than remote source expressions.
  return !normalized.startsWith("'");
}

function uniqueManifestValues(
  fields: Array<readonly [property: string, values: string[]]>,
): Array<{ value: string; property: string }> {
  const seen = new Set<string>();
  const values: Array<{ value: string; property: string }> = [];
  for (const [property, fieldValues] of fields) {
    for (const rawValue of fieldValues) {
      const value = rawValue.trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      values.push({ value, property });
    }
  }
  return values;
}

function browserTag(
  rule: keyof typeof BROWSER_RULE_IDS,
  finding: Omit<Finding, "ruleId" | "ruleVersion">,
): Finding {
  return { ...finding, ruleId: BROWSER_RULE_IDS[rule], ruleVersion: BROWSER_RULES_VERSION };
}
