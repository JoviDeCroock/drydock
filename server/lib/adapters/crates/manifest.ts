import { isRecord, isSafeManifestPath, parseArtifactFilesInputs } from "../artifact-input";
import {
  CRATE_NAME_RE,
  CRATES_ARTIFACT_LIMIT,
  CRATES_RELEASE_MANIFEST_SCHEMA,
  SAFE_VERSION_RE,
  SHA256_RE,
  type CratesAdapterInput,
  type CratesArtifactKind,
  type CratesIndexEntry,
  type CratesManifestSummary,
  type CratesReleaseManifest,
} from "./types";

export function isValidCrateName(name: string): boolean {
  return typeof name === "string" && CRATE_NAME_RE.test(name);
}

export function inferCratesArtifactKind(path: string): CratesArtifactKind | null {
  return path.toLowerCase().endsWith(".crate") ? "crate" : null;
}

export function parseCratesReleaseManifest(value: unknown): CratesReleaseManifest {
  if (!isRecord(value)) throw new Error("manifest must be an object");
  if (value.schema !== CRATES_RELEASE_MANIFEST_SCHEMA) {
    throw new Error(`manifest schema must be ${CRATES_RELEASE_MANIFEST_SCHEMA}`);
  }
  if (value.ecosystem !== "crates") throw new Error("manifest ecosystem must be crates");
  const packageName = String(value.package || "");
  const version = String(value.version || "");
  if (!isValidCrateName(packageName)) {
    throw new Error("manifest package is not a valid crates.io package name");
  }
  if (!SAFE_VERSION_RE.test(version)) {
    throw new Error("manifest version is not a safe crate version string");
  }
  if (!Array.isArray(value.artifacts) || !value.artifacts.length) {
    throw new Error("manifest must include at least one artifact");
  }
  if (value.artifacts.length > CRATES_ARTIFACT_LIMIT) {
    throw new Error(`manifest must include no more than ${CRATES_ARTIFACT_LIMIT} artifacts`);
  }

  const artifacts = value.artifacts.map((artifact, index) => {
    if (!isRecord(artifact)) throw new Error(`artifact ${index + 1} must be an object`);
    const path = String(artifact.path || "");
    if (!isSafeManifestPath(path)) throw new Error(`artifact ${index + 1} path is not safe`);
    const kind = inferCratesArtifactKind(path);
    if (!kind) throw new Error(`artifact ${index + 1} must be a .crate archive`);
    const sha256 = String(artifact.sha256 || "");
    if (!SHA256_RE.test(sha256))
      throw new Error(`artifact ${index + 1} sha256 must be a hex SHA-256 digest`);
    return { path, sha256: sha256.toLowerCase(), kind };
  });

  return {
    schema: CRATES_RELEASE_MANIFEST_SCHEMA,
    ecosystem: "crates",
    package: packageName,
    version,
    artifacts,
  };
}

export function parseCratesAdapterInput(raw: unknown): CratesAdapterInput {
  if (!isRecord(raw)) throw new Error("crates adapter input must be an object");
  const manifest = parseCratesReleaseManifest(raw.manifest ?? raw);
  return {
    manifest,
    artifacts: parseArtifactFilesInputs(raw.artifacts, "artifacts"),
    previousArtifacts:
      raw.previousArtifacts === undefined
        ? undefined
        : parseArtifactFilesInputs(raw.previousArtifacts, "previousArtifacts"),
    metadata: Array.isArray(raw.metadata) ? (raw.metadata as CratesIndexEntry[]) : undefined,
  };
}

const DEPENDENCY_SECTION_RE =
  /^(?:dependencies|dev-dependencies|build-dependencies|target\.[^\]]+\.(?:dependencies|dev-dependencies|build-dependencies))$/;

/**
 * Extract the Cargo.toml facts the deterministic rules need with a
 * line-oriented reader over the crate's normalized manifest text sample.
 * This intentionally handles only the subset cargo itself emits for published
 * crates (`cargo publish` normalizes the manifest); it never evaluates package
 * bytes and treats unparseable input as absent metadata (fail toward
 * `metadata-missing`, never a crash).
 */
export function parseCargoManifest(text: string): CratesManifestSummary {
  const summary: CratesManifestSummary = {
    name: null,
    version: null,
    links: null,
    buildValue: null,
    procMacro: false,
    nonRegistryDependencies: [],
  };
  let section = "";
  for (const rawLine of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const sectionMatch = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1]
        .trim()
        .replace(/\s*\.\s*/g, ".")
        .replace(/"/g, "");
      continue;
    }

    const keyValue = /^([A-Za-z0-9_-]+|"[^"]+")\s*=\s*(.+)$/.exec(line);
    if (!keyValue) continue;
    const key = keyValue[1].replace(/^"|"$/g, "");
    const value = keyValue[2].trim();

    if (section === "package") {
      if (key === "name") summary.name = parseTomlString(value);
      else if (key === "version") summary.version = parseTomlString(value);
      else if (key === "links") summary.links = parseTomlString(value);
      else if (key === "build") {
        if (value === "false") summary.buildValue = false;
        else if (value === "true") summary.buildValue = true;
        else summary.buildValue = parseTomlString(value);
      }
      continue;
    }
    if (section === "lib" && key === "proc-macro" && value.startsWith("true")) {
      summary.procMacro = true;
      continue;
    }
    if (DEPENDENCY_SECTION_RE.test(section)) {
      const source = inlineDependencySource(value);
      if (source) summary.nonRegistryDependencies.push({ name: key, source, section });
      continue;
    }
    const subsection = matchDependencySubsection(section);
    if (subsection && (key === "git" || key === "path")) {
      const already = summary.nonRegistryDependencies.some(
        (dep) => dep.name === subsection.name && dep.section === subsection.section,
      );
      if (!already) {
        summary.nonRegistryDependencies.push({
          name: subsection.name,
          source: key,
          section: subsection.section,
        });
      }
    }
  }
  return summary;
}

/** `[dependencies.foo]` (or dev/build/target variants) → its parent section + dep name. */
function matchDependencySubsection(section: string): { section: string; name: string } | null {
  const match =
    /^((?:dependencies|dev-dependencies|build-dependencies|target\.[^.]+(?:\.[^.]+)*?\.(?:dependencies|dev-dependencies|build-dependencies)))\.([A-Za-z0-9_-]+)$/.exec(
      section,
    );
  return match ? { section: match[1], name: match[2] } : null;
}

function inlineDependencySource(value: string): "git" | "path" | null {
  if (!value.startsWith("{")) return null;
  if (/[{,]\s*git\s*=/.test(value)) return "git";
  if (/[{,]\s*path\s*=/.test(value)) return "path";
  return null;
}

function parseTomlString(value: string): string | null {
  const match = /^"([^"]*)"/.exec(value);
  return match ? match[1] : null;
}
