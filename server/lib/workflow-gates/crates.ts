import {
  cratesAdapter,
  CRATES_RELEASE_MANIFEST_SCHEMA,
  inferCratesArtifactKind,
  parseCratesReleaseManifest,
  prepareCratesArtifact,
  type CratesArtifactInput,
  type CratesPreparedArtifact,
  type CratesReleaseManifest,
} from "../adapters/crates/index";
import type { AdapterBroker, PackageAdapter } from "../adapters/types";
import { WorkflowArtifactError } from "../github-app/artifacts";
import type {
  ArchiveContents,
  ParsedGateArtifact,
  PreparedReleaseCandidate,
  WorkflowArtifactKind,
  WorkflowGateAdapter,
} from "./types";

/**
 * crates.io workflow-gate adapter.
 *
 * The release set is whatever `cargo package` `.crate` archives (gzipped tars)
 * the workflow uploads. Identity (`package`/`version`) is read from each
 * crate's normalized `Cargo.toml` after the bytes are parsed in the shared
 * sandbox router. The deterministic review and baseline selection live in the
 * shared `cratesAdapter` (`server/lib/adapters/crates`); this adapter only owns
 * the gate-time artifact semantics.
 */
export const cratesWorkflowGateAdapter: WorkflowGateAdapter = {
  ecosystem: "crates",
  artifactName: "crates-release-candidate",
  packageAdapter: cratesAdapter as PackageAdapter<unknown, AdapterBroker>,

  classifyArtifact(path: string): WorkflowArtifactKind | null {
    return inferCratesArtifactKind(path);
  },

  detectArtifact(contents: ArchiveContents): WorkflowArtifactKind | null {
    // `cargo package` writes the pre-normalization manifest back as
    // `Cargo.toml.orig` next to the normalized `Cargo.toml` under the single
    // `{name}-{version}/` root. A vendored Cargo.toml deeper inside an npm
    // tarball must not claim the archive, so only the root placement counts.
    return contents.files.some((file) => isCrateRootManifestPath(file.path)) ? "crate" : null;
  },

  prepareReleaseCandidates(artifacts: ParsedGateArtifact[]): PreparedReleaseCandidate[] {
    const entries: PreparedArtifactEntry[] = artifacts.map((artifact) => {
      const input: CratesArtifactInput = {
        path: artifact.path,
        files: artifact.files,
        ...(artifact.suspiciousEntries ? { suspiciousEntries: artifact.suspiciousEntries } : {}),
      };
      return { artifact, input, prepared: prepareCratesArtifact(input) };
    });
    return deriveReleaseCandidates(entries);
  },
};

interface PreparedArtifactEntry {
  artifact: ParsedGateArtifact;
  input: CratesArtifactInput;
  prepared: CratesPreparedArtifact;
}

/**
 * Split the bundle's `.crate` archives into one candidate per distinct crate.
 *
 * A cargo workspace publishes several crates from one release, so archives are
 * grouped by their `Cargo.toml` name and each group becomes its own candidate →
 * its own scan against its own baseline. Every archive must expose a
 * `name`/`version`, and a single crate version is exactly one archive, so a
 * metadata-less or duplicated archive is rejected rather than silently shipped.
 */
function deriveReleaseCandidates(entries: PreparedArtifactEntry[]): PreparedReleaseCandidate[] {
  const groups = new Map<string, { version: string; entries: PreparedArtifactEntry[] }>();
  for (const entry of entries) {
    const { manifest } = entry.prepared.summary;
    if (!manifest.name || !manifest.version) {
      throw new WorkflowArtifactError(
        "artifact_identity_missing",
        `${entry.artifact.path} does not expose a Cargo.toml name/version`,
      );
    }
    const group = groups.get(manifest.name);
    if (!group) {
      groups.set(manifest.name, { version: manifest.version, entries: [entry] });
      continue;
    }
    if (manifest.version !== group.version) {
      throw new WorkflowArtifactError(
        "artifact_identity_inconsistent",
        `${entry.artifact.path} version ${manifest.version} disagrees with ${group.version} for ${manifest.name}`,
      );
    }
    // A single published crate version maps to exactly one `.crate`; two
    // archives claiming the same name+version is ambiguous and must not ship.
    throw new WorkflowArtifactError(
      "artifact_identity_inconsistent",
      `crate ${manifest.name} has more than one .crate archive in this release`,
    );
  }

  // `entries` is non-empty: the resolver throws `bundle_empty` for a bundle
  // with no reviewable artifacts, so `groups` always has at least one crate.
  return [...groups.entries()].map(([name, group]) => {
    const manifest = buildReleaseManifest(
      name,
      group.version,
      group.entries.map((entry) => entry.artifact),
    );
    return {
      ecosystem: "crates",
      pipelineInput: { manifest, artifacts: group.entries.map((entry) => entry.input) },
      package: { name: manifest.package, version: manifest.version },
    };
  });
}

function buildReleaseManifest(
  name: string,
  version: string,
  files: ParsedGateArtifact[],
): CratesReleaseManifest {
  const candidate = {
    schema: CRATES_RELEASE_MANIFEST_SCHEMA,
    ecosystem: "crates",
    package: name,
    version,
    artifacts: files.map((file) => ({ path: file.path, sha256: file.sha256 })),
  };
  try {
    return parseCratesReleaseManifest(candidate);
  } catch (err) {
    throw new WorkflowArtifactError(
      "artifact_identity_missing",
      err instanceof Error ? err.message : "derived release identity is not valid",
    );
  }
}

function isCrateRootManifestPath(path: string): boolean {
  const parts = path.split("/");
  return parts.length === 2 && parts[1] === "Cargo.toml.orig";
}
