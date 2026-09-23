import {
  inferPyPiArtifactKind,
  normalizePyPiProjectName,
  parsePyPiReleaseManifest,
  preparePyPiArtifact,
  pypiAdapter,
  PYPI_RELEASE_MANIFEST_SCHEMA,
  type PyPiArtifactInput,
  type PyPiPreparedArtifact,
} from "./";
import { erasePackageAdapter } from "../package-adapter";
import { WorkflowArtifactError } from "../../github-app/artifacts";
import { buildManifestOrFail, groupReleaseCandidates } from "../../workflow-gates/group-candidates";
import { compactDuplicateTextSamples } from "../../workflow-gates/resolve";
import type {
  ArchiveContents,
  ParsedGateArtifact,
  PreparedReleaseCandidate,
  WorkflowArtifactKind,
  WorkflowGateAdapter,
} from "../../workflow-gates/types";

/**
 * PyPI workflow-gate adapter.
 *
 * There is no maintainer-declared manifest: the release set is whatever
 * wheel/sdist files the bundle contains, and identity (`package`/`version`) is
 * derived from each wheel's `METADATA` / sdist's `PKG-INFO` after the bytes are
 * parsed in the shared sandbox router. The deterministic review + baseline
 * selection live in the shared `pypiAdapter` (`server/lib/ecosystems/pypi`); this
 * adapter only owns the gate-time artifact semantics.
 */
export const pypiWorkflowGateAdapter: WorkflowGateAdapter = {
  ecosystem: "pypi",
  artifactName: "pypi-release-candidate",
  // A platform wheel matrix can exceed the per-download ZIP cap, so PyPI
  // releases may shard across `pypi-release-candidate-*` uploads.
  shardedArtifactNames: true,
  packageAdapter: erasePackageAdapter(pypiAdapter),

  classifyArtifact(path: string): WorkflowArtifactKind | null {
    return inferPyPiArtifactKind(path);
  },

  detectArtifact(contents: ArchiveContents): WorkflowArtifactKind | null {
    // A PyPI sdist carries `PKG-INFO` at the archive root, usually under the
    // single project-version directory. Nested egg-info metadata can appear in
    // vendored files inside npm tarballs, so it must not claim the archive.
    return contents.files.some((file) => isSdistRootMetadataPath(file.path)) ? "sdist" : null;
  },

  // A PyPI release fans out into many platform wheels that repeat the same
  // pure-Python sources verbatim. Scope the dedupe by normalized project name so
  // two different projects in one bundle never share retained bodies, falling
  // back to the artifact path when the distribution carries no parseable name.
  narrowParsedArtifact(
    artifact: ParsedGateArtifact,
    retainedSamples: Map<string, string>,
  ): ParsedGateArtifact {
    const prepared = preparePyPiArtifact(pypiArtifactInput(artifact));
    const scope = prepared.summary.name
      ? normalizePyPiProjectName(prepared.summary.name)
      : artifact.path;
    return compactDuplicateTextSamples(artifact, retainedSamples, scope);
  },

  // Artifacts are grouped by normalized (PEP 503) name; one package version
  // legitimately spans many wheels plus an sdist, so several artifacts per
  // group are expected.
  prepareReleaseCandidates(artifacts: ParsedGateArtifact[]): PreparedReleaseCandidate[] {
    const entries: PreparedArtifactEntry[] = artifacts.map((artifact) => {
      const input = pypiArtifactInput(artifact);
      return { path: artifact.path, artifact, input, prepared: preparePyPiArtifact(input) };
    });
    return groupReleaseCandidates(entries, {
      identity(entry) {
        const { summary } = entry.prepared;
        if (!summary.name || !summary.version) {
          throw new WorkflowArtifactError(
            "artifact_identity_missing",
            `${entry.path} does not expose a PyPI Name/Version in its metadata`,
          );
        }
        return {
          key: normalizePyPiProjectName(summary.name),
          name: summary.name,
          version: summary.version,
        };
      },
      allowMultiplePerGroup: true,
      buildManifest: (identity, group) =>
        buildManifestOrFail(
          () =>
            parsePyPiReleaseManifest({
              schema: PYPI_RELEASE_MANIFEST_SCHEMA,
              ecosystem: "pypi",
              package: identity.name,
              version: identity.version,
              artifacts: group.map((entry) => ({
                path: entry.artifact.path,
                sha256: entry.artifact.sha256,
              })),
            }),
          "derived release identity is not valid",
        ),
      candidate: (manifest, group) => ({
        ecosystem: "pypi",
        pipelineInput: { manifest, artifacts: group.map((entry) => entry.input) },
        package: { name: manifest.package, version: manifest.version },
      }),
    });
  },
};

interface PreparedArtifactEntry {
  path: string;
  artifact: ParsedGateArtifact;
  input: PyPiArtifactInput;
  prepared: PyPiPreparedArtifact;
}

function pypiArtifactInput(artifact: ParsedGateArtifact): PyPiArtifactInput {
  return {
    path: artifact.path,
    files: artifact.files,
    ...(artifact.suspiciousEntries ? { suspiciousEntries: artifact.suspiciousEntries } : {}),
  };
}

function isSdistRootMetadataPath(path: string): boolean {
  if (path === "PKG-INFO") return true;
  const parts = path.split("/");
  return parts.length === 2 && parts[1] === "PKG-INFO";
}
