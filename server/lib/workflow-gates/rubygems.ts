import {
  GEM_METADATA_PATH,
  inferRubygemsArtifactKind,
  normalizeRubygemsGemName,
  parseRubygemsReleaseManifest,
  prepareRubygemsArtifact,
  rubygemsAdapter,
  RUBYGEMS_RELEASE_MANIFEST_SCHEMA,
  type RubygemsArtifactInput,
  type RubygemsPreparedArtifact,
  type RubygemsReleaseManifest,
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
 * There is no maintainer-declared manifest: the release set is whatever `.gem`
 * files the bundle contains, and identity (`package`/`version`) is derived from
 * each gem's serialized gemspec (`metadata.gz`) after the bytes are parsed in
 * the shared sandbox router. The deterministic review + baseline selection live
 * in the shared `rubygemsAdapter` (`server/lib/adapters/rubygems`); this
 * adapter only owns the gate-time artifact semantics.
 */
export const rubygemsWorkflowGateAdapter: WorkflowGateAdapter = {
  ecosystem: "rubygems",
  artifactName: "rubygems-release-candidates",
  packageAdapter: rubygemsAdapter as PackageAdapter<unknown, AdapterBroker>,

  classifyArtifact(path: string): WorkflowArtifactKind | null {
    return inferRubygemsArtifactKind(path);
  },

  detectArtifact(contents: ArchiveContents): WorkflowArtifactKind | null {
    // A parsed .gem surfaces its serialized gemspec as a root `metadata.gz`
    // record whose text is the Gem::Specification YAML document. The tag check
    // keeps a stray metadata.gz inside another ecosystem's archive from
    // claiming it.
    const metadata = contents.files.find((file) => file.path === GEM_METADATA_PATH);
    return metadata?.textSample?.includes("!ruby/object:Gem::Specification") ? "gem" : null;
  },

  prepareReleaseCandidates(artifacts: ParsedGateArtifact[]): PreparedReleaseCandidate[] {
    const entries: PreparedArtifactEntry[] = artifacts.map((artifact) => {
      const input: RubygemsArtifactInput = {
        path: artifact.path,
        files: artifact.files,
        ...(artifact.suspiciousEntries ? { suspiciousEntries: artifact.suspiciousEntries } : {}),
      };
      return { artifact, input, prepared: prepareRubygemsArtifact(input) };
    });
    return deriveReleaseCandidates(entries);
  },
};

interface PreparedArtifactEntry {
  artifact: ParsedGateArtifact;
  input: RubygemsArtifactInput;
  prepared: RubygemsPreparedArtifact;
}

/**
 * Split the bundle's `.gem` artifacts into one candidate per distinct gem.
 *
 * A monorepo publishes several gems from one release, so artifacts are grouped
 * by their normalized (lowercased) gemspec name and each group becomes its own
 * candidate → its own scan against its own baseline. Identity comes from each
 * gem's serialized gemspec; the SHA-256 is the digest already recomputed from
 * the bundle bytes.
 *
 * Every artifact must expose a gemspec name/version, and all artifacts that
 * share a name must agree on the version and carry distinct platforms, so a
 * metadata-less, version-skewed, or platform-duplicated file slipped into a
 * gem's set is rejected rather than silently shipped.
 */
function deriveReleaseCandidates(entries: PreparedArtifactEntry[]): PreparedReleaseCandidate[] {
  const groups = new Map<
    string,
    { name: string; version: string; platforms: Set<string>; entries: PreparedArtifactEntry[] }
  >();
  for (const entry of entries) {
    const { summary } = entry.prepared;
    if (!summary.name || !summary.version) {
      throw new WorkflowArtifactError(
        "artifact_identity_missing",
        `${entry.artifact.path} does not expose a gemspec name/version in its metadata`,
      );
    }
    const platform = summary.platform || "ruby";
    const normalized = normalizeRubygemsGemName(summary.name);
    const group = groups.get(normalized);
    if (!group) {
      groups.set(normalized, {
        name: summary.name,
        version: summary.version,
        platforms: new Set([platform]),
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
    if (group.platforms.has(platform)) {
      throw new WorkflowArtifactError(
        "artifact_identity_inconsistent",
        `${entry.artifact.path} duplicates platform ${platform} for ${group.name} ${group.version}`,
      );
    }
    group.platforms.add(platform);
    group.entries.push(entry);
  }

  // `entries` is non-empty: the resolver throws `bundle_empty` when a bundle
  // has no .gem files, so `groups` always has at least one gem here.
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
): RubygemsReleaseManifest {
  const candidate = {
    schema: RUBYGEMS_RELEASE_MANIFEST_SCHEMA,
    ecosystem: "rubygems",
    package: name,
    version,
    artifacts: files.map((file) => ({ path: file.path, sha256: file.sha256 })),
  };
  try {
    return parseRubygemsReleaseManifest(candidate);
  } catch (err) {
    throw new WorkflowArtifactError(
      "artifact_identity_missing",
      err instanceof Error ? err.message : "derived release identity is not valid",
    );
  }
}
