import {
  composerAdapter,
  COMPOSER_RELEASE_MANIFEST_SCHEMA,
  COMPOSER_UNVERSIONED,
  inferComposerArtifactKind,
  normalizeComposerPackageName,
  parseComposerReleaseManifest,
  prepareComposerArtifact,
  type ComposerArtifactInput,
  type ComposerPreparedArtifact,
  type ComposerReleaseManifest,
} from "../adapters/composer/index";
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
 * Composer workflow-gate adapter.
 *
 * There is no maintainer-declared manifest: the release set is whatever
 * `composer archive`-style ZIP/TAR archives the bundle contains, and identity
 * (`package`/`version`) is derived from each archive's root `composer.json`
 * after the bytes are parsed in the shared sandbox router. `name` is required;
 * `version` may be absent (Packagist derives it from the VCS tag), in which
 * case the candidate reviews against the latest published baseline. The
 * deterministic review + baseline selection live in the shared
 * `composerAdapter` (`server/lib/adapters/composer`); this adapter only owns
 * the gate-time artifact semantics.
 */
export const composerWorkflowGateAdapter: WorkflowGateAdapter = {
  ecosystem: "composer",
  artifactName: "composer-release-candidate",
  packageAdapter: composerAdapter as PackageAdapter<unknown, AdapterBroker>,

  classifyArtifact(path: string): WorkflowArtifactKind | null {
    return inferComposerArtifactKind(path);
  },

  detectArtifact(contents: ArchiveContents): WorkflowArtifactKind | null {
    // A Composer archive carries `composer.json` at the archive root —
    // directly for `composer archive` output, or under the single
    // `<repo>-<ref>/` directory for git/GitHub archives. Nested composer.json
    // files (fixtures, vendored packages) must not claim the archive.
    return contents.files.some((file) => isComposerRootManifestPath(file.path)) ? "zip" : null;
  },

  prepareReleaseCandidates(artifacts: ParsedGateArtifact[]): PreparedReleaseCandidate[] {
    const entries: PreparedArtifactEntry[] = artifacts.map((artifact) => {
      const input: ComposerArtifactInput = {
        path: artifact.path,
        files: artifact.files,
        ...(artifact.suspiciousEntries ? { suspiciousEntries: artifact.suspiciousEntries } : {}),
      };
      return { artifact, input, prepared: prepareComposerArtifact(input) };
    });
    return deriveReleaseCandidates(entries);
  },
};

interface PreparedArtifactEntry {
  artifact: ParsedGateArtifact;
  input: ComposerArtifactInput;
  prepared: ComposerPreparedArtifact;
}

/**
 * Split the bundle's Composer artifacts into one candidate per distinct
 * package.
 *
 * A monorepo publishes several packages from one release, so artifacts are
 * grouped by their normalized `composer.json` name and each group becomes its
 * own candidate → its own scan against its own baseline. `composer archive`
 * produces exactly one archive per package, so a group with more than one
 * archive means two archives claim the same package — rejected rather than
 * silently merged. A missing `name` is rejected too; a missing `version` is
 * tolerated (Packagist derives it from the VCS tag) and reviewed against the
 * latest published baseline.
 */
function deriveReleaseCandidates(entries: PreparedArtifactEntry[]): PreparedReleaseCandidate[] {
  const groups = new Map<
    string,
    { name: string; version: string; entries: PreparedArtifactEntry[] }
  >();
  for (const entry of entries) {
    const { summary } = entry.prepared;
    if (!summary.name) {
      throw new WorkflowArtifactError(
        "artifact_identity_missing",
        `${entry.artifact.path} does not expose a root composer.json with a package name`,
      );
    }
    const normalized = normalizeComposerPackageName(summary.name);
    const version = summary.version ?? COMPOSER_UNVERSIONED;
    const group = groups.get(normalized);
    if (!group) {
      groups.set(normalized, { name: summary.name, version, entries: [entry] });
      continue;
    }
    throw new WorkflowArtifactError(
      "artifact_identity_inconsistent",
      `${entry.artifact.path} and ${group.entries[0].artifact.path} both claim Composer package ${group.name}; a release ships one archive per package`,
    );
  }

  // `entries` is non-empty: the resolver throws `bundle_empty` when a bundle
  // has no reviewable archives, so `groups` always has at least one package.
  return [...groups.values()].map((group) => {
    const manifest = buildReleaseManifest(
      group.name,
      group.version,
      group.entries.map((entry) => entry.artifact),
    );
    return {
      ecosystem: "composer",
      pipelineInput: { manifest, artifacts: group.entries.map((entry) => entry.input) },
      package: { name: manifest.package, version: manifest.version },
    };
  });
}

function buildReleaseManifest(
  name: string,
  version: string,
  files: ParsedGateArtifact[],
): ComposerReleaseManifest {
  const candidate = {
    schema: COMPOSER_RELEASE_MANIFEST_SCHEMA,
    ecosystem: "composer",
    package: name,
    version,
    artifacts: files.map((file) => ({ path: file.path, sha256: file.sha256 })),
  };
  try {
    return parseComposerReleaseManifest(candidate);
  } catch (err) {
    throw new WorkflowArtifactError(
      "artifact_identity_missing",
      err instanceof Error ? err.message : "derived release identity is not valid",
    );
  }
}

function isComposerRootManifestPath(path: string): boolean {
  if (path === "composer.json") return true;
  const parts = path.split("/");
  return parts.length === 2 && parts[1] === "composer.json";
}
