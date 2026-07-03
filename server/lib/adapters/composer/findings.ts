import { type FileRecord, type Finding, tarSuspiciousEntryFindings } from "../../review";
import { safeJson } from "../../review-rules";
import { isRecord, normalizeComposerPackageName } from "./manifest";
import {
  COMPOSER_RULE_IDS,
  COMPOSER_RULES_VERSION,
  COMPOSER_UNVERSIONED,
  type ComposerJsonSummary,
  type ComposerPreparedArtifact,
  type ComposerReleaseManifest,
  type ComposerRepositoryEntry,
} from "./types";

export function composerReleaseFindings(
  manifest: ComposerReleaseManifest,
  artifacts: ComposerPreparedArtifact[],
  baseline: ComposerJsonSummary | null,
): Finding[] {
  const findings: Finding[] = [];

  for (const artifact of artifacts) {
    const { summary } = artifact;
    for (const finding of tarSuspiciousEntryFindings(artifact.suspiciousEntries)) {
      findings.push({ ...finding, file: namespacedPath(artifact.path, finding.file) });
    }
    const composerJsonPath = namespacedPath(artifact.path, summary.path ?? "composer.json");

    if (!summary.path || !summary.name) {
      findings.push(
        tag("manifestMissing", {
          severity: "medium",
          file: composerJsonPath,
          evidence: `${artifact.path} does not expose a root composer.json with a package name`,
          reason:
            "release gates need the composer.json name to prove the artifact matches the reviewed manifest",
        }),
      );
    } else if (normalizeComposerPackageName(summary.name) !== manifest.package) {
      findings.push(
        tag("manifestMismatch", {
          severity: "critical",
          file: composerJsonPath,
          evidence: `${artifact.path} composer.json name ${summary.name} != manifest package ${manifest.package}`,
          reason: "the release artifact package name does not match the reviewed Composer manifest",
        }),
      );
    }
    if (
      summary.version &&
      manifest.version !== COMPOSER_UNVERSIONED &&
      summary.version !== manifest.version
    ) {
      findings.push(
        tag("manifestMismatch", {
          severity: "critical",
          file: composerJsonPath,
          evidence: `${artifact.path} composer.json version ${summary.version} != manifest version ${manifest.version}`,
          reason: "the release artifact version does not match the reviewed Composer manifest",
        }),
      );
    }

    findings.push(...composerJsonRiskFindings(summary, baseline, composerJsonPath));
  }

  return findings;
}

// Manifest-shape rules for a staged composer.json, compared against the
// baseline release's composer.json when one is available. Without a baseline
// every declaration counts as new — a first release gets full scrutiny.
function composerJsonRiskFindings(
  summary: ComposerJsonSummary,
  baseline: ComposerJsonSummary | null,
  composerJsonPath: string,
): Finding[] {
  const findings: Finding[] = [];

  const isPlugin = summary.type === "composer-plugin";
  const baselineIsPlugin = baseline?.type === "composer-plugin";
  if (isPlugin && (!baselineIsPlugin || summary.pluginClass !== baseline?.pluginClass)) {
    findings.push(
      tag("composerPlugin", {
        severity: "high",
        file: composerJsonPath,
        evidence: summary.pluginClass
          ? `type composer-plugin with extra.class ${summary.pluginClass}`
          : "type composer-plugin",
        reason:
          "Composer plugins execute their PHP entry class inside the consumer's Composer process during install/update",
      }),
    );
  }

  if (
    summary.requireComposerPluginApi &&
    summary.requireComposerPluginApi !== baseline?.requireComposerPluginApi
  ) {
    findings.push(
      tag("pluginApiRequirement", {
        severity: baseline?.requireComposerPluginApi ? "medium" : "high",
        file: composerJsonPath,
        evidence: `require composer-plugin-api: ${summary.requireComposerPluginApi}`,
        reason:
          "requiring composer-plugin-api marks the package as a Composer plugin whose code runs in the consumer's Composer process",
      }),
    );
  }

  const baselineAllowed = new Set(baseline?.allowPlugins ?? []);
  const newAllowPlugins = summary.allowPlugins.filter((plugin) => !baselineAllowed.has(plugin));
  if (summary.allowPluginsAll && !baseline?.allowPluginsAll) {
    findings.push(
      tag("allowPlugins", {
        severity: "high",
        file: composerJsonPath,
        evidence: "config.allow-plugins allows every plugin",
        reason:
          "allowing all Composer plugins lets any dependency execute code during the consumer's install",
      }),
    );
  } else if (newAllowPlugins.length) {
    findings.push(
      tag("allowPlugins", {
        severity: newAllowPlugins.includes("*") ? "high" : "medium",
        file: composerJsonPath,
        evidence: `config.allow-plugins adds: ${newAllowPlugins.join(", ")}`,
        reason: "newly allowed Composer plugins execute code during the consumer's install/update",
      }),
    );
  }

  const baselineAutoload = new Set(baseline?.autoloadFiles ?? []);
  const newAutoloadFiles = summary.autoloadFiles.filter((file) => !baselineAutoload.has(file));
  if (newAutoloadFiles.length) {
    findings.push(
      tag("autoloadFiles", {
        severity: "high",
        file: composerJsonPath,
        evidence: `autoload.files adds: ${newAutoloadFiles.join(", ")}`,
        reason:
          "autoload.files entries execute unconditionally on every request that loads the Composer autoloader",
      }),
    );
  }

  const baselineBin = new Set(baseline?.bin ?? []);
  const newBin = summary.bin.filter((entry) => !baselineBin.has(entry));
  if (newBin.length) {
    findings.push(
      tag("binEntry", {
        severity: "medium",
        file: composerJsonPath,
        evidence: `bin adds: ${newBin.join(", ")}`,
        reason:
          "bin entries are installed as executables into the consumer's vendor/bin and run with their privileges",
      }),
    );
  }

  const baselineRepos = new Set((baseline?.repositories ?? []).map(repositoryKey));
  for (const repository of summary.repositories) {
    if (baselineRepos.has(repositoryKey(repository))) continue;
    const insecureUrl = repository.url !== null && !/^https:\/\//i.test(repository.url);
    findings.push(
      tag("customRepository", {
        severity: insecureUrl ? "high" : "medium",
        file: composerJsonPath,
        evidence:
          `custom repository: ${repository.type ?? "unknown"} ${repository.url ?? ""}`.trim(),
        reason: insecureUrl
          ? "a non-HTTPS custom repository lets dependencies be swapped in transit or served from an arbitrary location"
          : "custom repositories bypass Packagist and can serve unreviewed or shadowed dependency code",
      }),
    );
  }

  const baselineShadow = new Set([...(baseline?.replace ?? []), ...(baseline?.provide ?? [])]);
  const newShadowed = [...summary.replace, ...summary.provide].filter(
    (name) => !baselineShadow.has(name),
  );
  if (newShadowed.length) {
    findings.push(
      tag("packageShadowing", {
        severity: "medium",
        file: composerJsonPath,
        evidence: `replace/provide adds: ${newShadowed.join(", ")}`,
        reason:
          "replace/provide entries can substitute this package's code for another package consumers believe they installed",
      }),
    );
  }

  if (
    summary.minimumStability === "dev" &&
    summary.preferStable !== true &&
    (baseline === null || baseline.minimumStability !== "dev" || baseline.preferStable === true)
  ) {
    findings.push(
      tag("unstableStability", {
        severity: "low",
        file: composerJsonPath,
        evidence: "minimum-stability dev without prefer-stable",
        reason:
          "dev minimum-stability without prefer-stable resolves dependencies to unreviewed development snapshots",
      }),
    );
  }

  if (summary.secureHttpDisabled && !baseline?.secureHttpDisabled) {
    findings.push(
      tag("sourceInstall", {
        severity: "high",
        file: composerJsonPath,
        evidence: "config.secure-http disabled",
        reason:
          "disabling secure-http allows dependency downloads over plaintext HTTP, enabling in-transit substitution",
      }),
    );
  }
  if (summary.preferredInstallSource && !baseline?.preferredInstallSource) {
    findings.push(
      tag("sourceInstall", {
        severity: "medium",
        file: composerJsonPath,
        evidence: "config.preferred-install source",
        reason:
          "source installs clone VCS repositories instead of the reviewed dist archive, so installed bytes can differ from the release",
      }),
    );
  }

  return findings;
}

export function summarizeComposerArtifact(
  artifactPath: string,
  files: FileRecord[],
): ComposerJsonSummary {
  const composerJsonFile = findComposerJsonFile(files);
  const parsed = composerJsonFile ? parseComposerJson(composerJsonFile) : null;
  return {
    ...(parsed ?? emptyComposerJsonSummary()),
    path: composerJsonFile && parsed ? composerJsonFile.path : (composerJsonFile?.path ?? null),
  };
}

// Parse a baseline archive's root composer.json so staged manifest rules can
// fire only on new or changed declarations.
export function summarizeBaselineComposerJson(
  files: Array<Pick<FileRecord, "path" | "textSample" | "flags">> | undefined,
): ComposerJsonSummary | null {
  if (!files?.length) return null;
  const composerJsonFile = files.find((file) => file.path.split("/").at(-1) === "composer.json");
  if (!composerJsonFile) return null;
  const parsed = parseComposerJson(composerJsonFile);
  return parsed ? { ...parsed, path: composerJsonFile.path } : null;
}

export function namespacedPath(artifactPath: string, filePath: string): string {
  return `${artifactPath.replace(/\/+$/, "")}/${filePath.replace(/^\/+/, "")}`;
}

// The root composer.json of the (root-stripped) archive. Nested composer.json
// files (fixtures, embedded packages) never define the release identity.
export function findComposerJsonFile(files: FileRecord[]): FileRecord | undefined {
  return files.find((file) => file.path === "composer.json");
}

function parseComposerJson(
  file: Pick<FileRecord, "textSample" | "flags">,
): Omit<ComposerJsonSummary, "path"> | null {
  if (file.textSample === undefined || file.flags.includes("truncated")) return null;
  const json = safeJson(file.textSample);
  if (!isRecord(json)) return null;

  const config = isRecord(json.config) ? json.config : {};
  const extra = isRecord(json.extra) ? json.extra : {};
  const require = isRecord(json.require) ? json.require : {};
  const autoload = isRecord(json.autoload) ? json.autoload : {};
  const allowPluginsRaw = config["allow-plugins"];

  return {
    name: typeof json.name === "string" ? json.name : null,
    version: typeof json.version === "string" ? json.version : null,
    type: typeof json.type === "string" ? json.type : null,
    requireComposerPluginApi:
      typeof require["composer-plugin-api"] === "string" ? require["composer-plugin-api"] : null,
    pluginClass: typeof extra.class === "string" ? extra.class : null,
    allowPluginsAll: allowPluginsRaw === true,
    allowPlugins: isRecord(allowPluginsRaw)
      ? Object.entries(allowPluginsRaw)
          .filter(([, allowed]) => allowed === true)
          .map(([plugin]) => plugin)
      : [],
    autoloadFiles: stringArray(autoload.files),
    bin: typeof json.bin === "string" ? [json.bin] : stringArray(json.bin),
    repositories: parseRepositories(json.repositories),
    replace: isRecord(json.replace) ? Object.keys(json.replace) : [],
    provide: isRecord(json.provide) ? Object.keys(json.provide) : [],
    minimumStability:
      typeof json["minimum-stability"] === "string" ? json["minimum-stability"] : null,
    preferStable: typeof json["prefer-stable"] === "boolean" ? json["prefer-stable"] : null,
    preferredInstallSource: preferredInstallIncludesSource(config["preferred-install"]),
    secureHttpDisabled: config["secure-http"] === false,
  };
}

function emptyComposerJsonSummary(): Omit<ComposerJsonSummary, "path"> {
  return {
    name: null,
    version: null,
    type: null,
    requireComposerPluginApi: null,
    pluginClass: null,
    allowPluginsAll: false,
    allowPlugins: [],
    autoloadFiles: [],
    bin: [],
    repositories: [],
    replace: [],
    provide: [],
    minimumStability: null,
    preferStable: null,
    preferredInstallSource: false,
    secureHttpDisabled: false,
  };
}

function parseRepositories(raw: unknown): ComposerRepositoryEntry[] {
  const entries = Array.isArray(raw) ? raw : isRecord(raw) ? Object.values(raw) : [];
  const repositories: ComposerRepositoryEntry[] = [];
  for (const entry of entries) {
    if (entry === false) continue; // `{"packagist.org": false}` disables a repo
    if (!isRecord(entry)) continue;
    repositories.push({
      type: typeof entry.type === "string" ? entry.type : null,
      url: typeof entry.url === "string" ? entry.url : null,
    });
  }
  return repositories;
}

function preferredInstallIncludesSource(raw: unknown): boolean {
  if (raw === "source") return true;
  if (isRecord(raw)) return Object.values(raw).some((value) => value === "source");
  return false;
}

function stringArray(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === "string")
    : [];
}

function repositoryKey(repository: ComposerRepositoryEntry): string {
  return `${repository.type ?? ""}\u0000${repository.url ?? ""}`;
}

function tag(
  rule: keyof typeof COMPOSER_RULE_IDS,
  finding: Omit<Finding, "ruleId" | "ruleVersion">,
): Finding {
  return {
    ...finding,
    ruleId: COMPOSER_RULE_IDS[rule],
    ruleVersion: COMPOSER_RULES_VERSION,
  };
}
