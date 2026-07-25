import {
  inferPyPiArtifactKind,
  normalizePyPiProjectName,
  parsePyPiReleaseManifest,
  preparePyPiArtifact,
  pypiAdapter,
  PYPI_RELEASE_MANIFEST_SCHEMA,
  type PyPiArtifactInput,
  type PyPiPreparedArtifact,
  type PyPiReleaseManifest,
} from "../adapters/pypi/index";
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
 * PyPI workflow-gate adapter.
 *
 * There is no maintainer-declared manifest: the release set is whatever
 * wheel/sdist files the bundle contains, and identity (`package`/`version`) is
 * derived from each wheel's `METADATA` / sdist's `PKG-INFO` after the bytes are
 * parsed in the shared sandbox router. The deterministic review + baseline
 * selection live in the shared `pypiAdapter` (`server/lib/adapters/pypi`); this
 * adapter only owns the gate-time artifact semantics.
 */
export const pypiWorkflowGateAdapter: WorkflowGateAdapter = {
  ecosystem: "pypi",
  artifactName: "pypi-release-candidate",
  // A platform wheel matrix can exceed the per-download ZIP cap, so PyPI
  // releases may shard across `pypi-release-candidate-*` uploads.
  shardedArtifactNames: true,
  packageAdapter: pypiAdapter as PackageAdapter<unknown, AdapterBroker>,

  classifyArtifact(path: string): WorkflowArtifactKind | null {
    return inferPyPiArtifactKind(path);
  },

  detectArtifact(contents: ArchiveContents): WorkflowArtifactKind | null {
    // A PyPI sdist carries `PKG-INFO` at the archive root, usually under the
    // single project-version directory. Nested egg-info metadata can appear in
    // vendored files inside npm tarballs, so it must not claim the archive.
    return contents.files.some((file) => isSdistRootMetadataPath(file.path)) ? "sdist" : null;
  },

  prepareReleaseCandidates(artifacts: ParsedGateArtifact[]): PreparedReleaseCandidate[] {
    const entries: PreparedArtifactEntry[] = artifacts.map((artifact) => {
      const input: PyPiArtifactInput = {
        path: artifact.path,
        files: artifact.files,
        ...(artifact.suspiciousEntries ? { suspiciousEntries: artifact.suspiciousEntries } : {}),
      };
      return { artifact, input, prepared: preparePyPiArtifact(input) };
    });
    return deriveReleaseCandidates(entries);
  },
};

interface PreparedArtifactEntry {
  artifact: ParsedGateArtifact;
  input: PyPiArtifactInput;
  prepared: PyPiPreparedArtifact;
}

/**
 * Split the bundle's PyPI artifacts into one candidate per distinct package.
 *
 * A monorepo publishes several packages from one release, so artifacts are
 * grouped by their normalized (PEP 503) name and each group becomes its own
 * candidate → its own scan against its own baseline. Identity comes from each
 * wheel's `METADATA` / sdist's `PKG-INFO`; the SHA-256 is the digest already
 * recomputed from the bundle bytes.
 *
 * Every artifact must expose a `Name`/`Version`, and all artifacts that share a
 * normalized name must agree on the version, so a metadata-less or
 * version-skewed file slipped into a package's set is rejected rather than
 * silently shipped. Distinct packages with distinct names are kept apart — that
 * is the expected monorepo shape, not a conflict.
 */
function deriveReleaseCandidates(entries: PreparedArtifactEntry[]): PreparedReleaseCandidate[] {
  const groups = new Map<
    string,
    { name: string; version: string; entries: PreparedArtifactEntry[] }
  >();
  for (const entry of entries) {
    const { summary } = entry.prepared;
    if (!summary.name || !summary.version) {
      throw new WorkflowArtifactError(
        "artifact_identity_missing",
        `${entry.artifact.path} does not expose a PyPI Name/Version in its metadata`,
      );
    }
    const normalized = normalizePyPiProjectName(summary.name);
    const group = groups.get(normalized);
    if (!group) {
      groups.set(normalized, { name: summary.name, version: summary.version, entries: [entry] });
      continue;
    }
    if (summary.version !== group.version) {
      throw new WorkflowArtifactError(
        "artifact_identity_inconsistent",
        `${entry.artifact.path} version ${summary.version} disagrees with ${group.version} for ${group.name}`,
      );
    }
    group.entries.push(entry);
  }

  // `entries` is non-empty: the resolver throws `bundle_empty` when a bundle has
  // no wheels/sdists, so `groups` always has at least one package here.
  return [...groups.values()].map((group) => {
    const manifest = buildReleaseManifest(
      group.name,
      group.version,
      group.entries.map((entry) => entry.artifact),
    );
    return {
      ecosystem: "pypi",
      pipelineInput: { manifest, artifacts: group.entries.map((entry) => entry.input) },
      package: { name: manifest.package, version: manifest.version },
    };
  });
}

function buildReleaseManifest(
  name: string,
  version: string,
  files: ParsedGateArtifact[],
): PyPiReleaseManifest {
  const candidate = {
    schema: PYPI_RELEASE_MANIFEST_SCHEMA,
    ecosystem: "pypi",
    package: name,
    version,
    artifacts: files.map((file) => ({ path: file.path, sha256: file.sha256 })),
  };
  try {
    return parsePyPiReleaseManifest(candidate);
  } catch (err) {
    throw new WorkflowArtifactError(
      "artifact_identity_missing",
      err instanceof Error ? err.message : "derived release identity is not valid",
    );
  }
}

function isSdistRootMetadataPath(path: string): boolean {
  if (path === "PKG-INFO") return true;
  const parts = path.split("/");
  return parts.length === 2 && parts[1] === "PKG-INFO";
}
