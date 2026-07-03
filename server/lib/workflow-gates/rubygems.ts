import {
  normalizeGemName,
  parseRubyGemsReleaseManifest,
  prepareRubyGemsArtifact,
  RUBYGEMS_RELEASE_MANIFEST_SCHEMA,
  rubygemsAdapter,
  type RubyGemsArtifactInput,
  type RubyGemsPreparedArtifact,
  type RubyGemsReleaseManifest,
} from "../adapters/rubygems/index";
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
 * RubyGems workflow-gate adapter.
 *
 * Unlike the npm/PyPI archives, a `.gem` extension is unique to RubyGems, so
 * classification is purely by path and `detectArtifact` never needs to claim an
 * ambiguous archive. Identity (`package`/`version`/`platform`) is derived from
 * each gem's `metadata.gz` Gem::Specification, which the shared sandbox surfaces
 * as `gemMetadata` after parsing the nested `.gem` container. The deterministic
 * review + baseline selection live in the shared `rubygemsAdapter`
 * (`server/lib/adapters/rubygems`); this adapter owns only the gate-time
 * artifact semantics.
 */
export const rubygemsWorkflowGateAdapter: WorkflowGateAdapter = {
  ecosystem: "rubygems",
  artifactName: "rubygems-release-candidate",
  packageAdapter: rubygemsAdapter as PackageAdapter<unknown, AdapterBroker>,

  classifyArtifact(path: string): WorkflowArtifactKind | null {
    return path.toLowerCase().endsWith(".gem") ? "gem" : null;
  },

  detectArtifact(_contents: ArchiveContents): WorkflowArtifactKind | null {
    // `.gem` is path-unique; content detection is only used to disambiguate an
    // extension claimed by more than one ecosystem, which never happens here.
    return null;
  },

  prepareReleaseCandidates(artifacts: ParsedGateArtifact[]): PreparedReleaseCandidate[] {
    const entries: PreparedGemEntry[] = artifacts.map((artifact) => {
      const input: RubyGemsArtifactInput = {
        path: artifact.path,
        files: artifact.files,
        gemMetadata: artifact.gemMetadata ?? null,
        ...(artifact.suspiciousEntries ? { suspiciousEntries: artifact.suspiciousEntries } : {}),
      };
      return { artifact, input, prepared: prepareRubyGemsArtifact(input) };
    });
    return deriveReleaseCandidates(entries);
  },
};

interface PreparedGemEntry {
  artifact: ParsedGateArtifact;
  input: RubyGemsArtifactInput;
  prepared: RubyGemsPreparedArtifact;
}

/**
 * Split the bundle's `.gem` artifacts into one candidate per distinct gem.
 *
 * A monorepo (or a native gem) publishes several `.gem` files from one release;
 * they are grouped by normalized gem name and each group becomes its own
 * candidate → its own scan against its own baseline. Identity comes from each
 * gem's Gem::Specification; every gem must expose a `name`/`version`, gems that
 * share a name must agree on the version, and two gems claiming the same name +
 * platform are rejected (a single name/version/platform is exactly one `.gem`),
 * so a metadata-less, version-skewed, or duplicated file is rejected rather than
 * silently shipped. Distinct platforms of the same gem are the expected
 * native-gem shape, not a conflict.
 */
function deriveReleaseCandidates(entries: PreparedGemEntry[]): PreparedReleaseCandidate[] {
  const groups = new Map<
    string,
    { name: string; version: string; platforms: Set<string>; entries: PreparedGemEntry[] }
  >();
  for (const entry of entries) {
    const { summary } = entry.prepared;
    if (!summary.name || !summary.version) {
      throw new WorkflowArtifactError(
        "artifact_identity_missing",
        `${entry.artifact.path} does not expose a gem name/version in its metadata`,
      );
    }
    const normalized = normalizeGemName(summary.name);
    const group = groups.get(normalized);
    if (!group) {
      groups.set(normalized, {
        name: summary.name,
        version: summary.version,
        platforms: new Set([summary.platform]),
        entries: [entry],
      });
      continue;
    }
    if (summary.version !== group.version) {
      throw new WorkflowArtifactError(
        "artifact_identity_inconsistent",
        `${entry.artifact.path} version ${summary.version} disagrees with ${group.version} for ${group.name}`,
      );
    }
    if (group.platforms.has(summary.platform)) {
      throw new WorkflowArtifactError(
        "artifact_identity_inconsistent",
        `${entry.artifact.path} duplicates platform ${summary.platform} for ${group.name} ${group.version}`,
      );
    }
    group.platforms.add(summary.platform);
    group.entries.push(entry);
  }

  // `entries` is non-empty: the resolver throws `bundle_empty` when a bundle has
  // no `.gem` files, so `groups` always has at least one gem here.
  return [...groups.values()].map((group) => {
    const manifest = buildReleaseManifest(
      group.name,
      group.version,
      group.entries.map((entry) => entry.artifact),
    );
    return {
      ecosystem: "rubygems",
      pipelineInput: { manifest, artifacts: group.entries.map((entry) => entry.input) },
      package: { name: manifest.package, version: manifest.version },
    };
  });
}

function buildReleaseManifest(
  name: string,
  version: string,
  files: ParsedGateArtifact[],
): RubyGemsReleaseManifest {
  const candidate = {
    schema: RUBYGEMS_RELEASE_MANIFEST_SCHEMA,
    ecosystem: "rubygems",
    package: name,
    version,
    artifacts: files.map((file) => ({ path: file.path, sha256: file.sha256 })),
  };
  try {
    return parseRubyGemsReleaseManifest(candidate);
  } catch (err) {
    throw new WorkflowArtifactError(
      "artifact_identity_missing",
      err instanceof Error ? err.message : "derived release identity is not valid",
    );
  }
}
