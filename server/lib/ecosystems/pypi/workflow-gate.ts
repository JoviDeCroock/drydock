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
} from "./";
import type { AdapterBroker, PackageAdapter } from "../package-adapter";
import { WorkflowArtifactError } from "../../github-app/artifacts";
import { compactDuplicateTextSamples } from "../../workflow-gates/resolve";
import type {
  ArchiveContents,
  GateSetupTemplate,
  GateSetupTemplateInput,
  ParsedGateArtifact,
  PreparedReleaseCandidate,
  WorkflowArtifactKind,
  WorkflowGateAdapter,
} from "../../workflow-gates/types";

const PYPI_GATE_ARTIFACT_NAME = "pypi-release-candidate";

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
  artifactName: PYPI_GATE_ARTIFACT_NAME,
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

  // A PyPI release fans out into many platform wheels that repeat the same
  // pure-Python sources verbatim. Scope the dedupe by normalized project name so
  // two different projects in one bundle never share retained bodies, falling
  // back to the artifact path when the distribution carries no parseable name.
  narrowParsedArtifact(
    artifact: ParsedGateArtifact,
    retainedSamples: Map<string, string>,
  ): ParsedGateArtifact {
    const prepared = preparePyPiArtifact({
      path: artifact.path,
      files: artifact.files,
      ...(artifact.suspiciousEntries ? { suspiciousEntries: artifact.suspiciousEntries } : {}),
    });
    const scope = prepared.summary.name
      ? normalizePyPiProjectName(prepared.summary.name)
      : artifact.path;
    return compactDuplicateTextSamples(artifact, retainedSamples, scope);
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

  gateSetupTemplate(input: GateSetupTemplateInput): GateSetupTemplate {
    return pypiGateSetupTemplate(input);
  },
};

/**
 * The PyPI publish workflow the setup wizard offers as a pull request.
 *
 * Same contract as the canonical example in `docs/workflow-gates.md`: build
 * once, record `SHA256SUMS` in `dist/`, upload the whole directory, pause at
 * the gated environment, re-check the digests on download, and hand the
 * reviewed distributions to `pypa/gh-action-pypi-publish` over OIDC.
 * `SHA256SUMS` is removed just before publish so it is never uploaded to PyPI.
 */
function pypiGateSetupTemplate({
  environmentName,
  packageName,
}: GateSetupTemplateInput): GateSetupTemplate {
  return {
    workflowPath: ".github/workflows/drydock-pypi-release.yml",
    yaml: `# Drydock workflow gate — PyPI
# Project: ${packageName}
# Drydock reviews the built wheels/sdist before the publish job is allowed to run.
name: "Publish ${packageName}"

on:
  workflow_dispatch:
  push:
    tags:
      - "v*"

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.x"
      - run: python -m pip install build
      - run: python -m build
      # Record the digests Drydock reviews and the publish job re-checks.
      - run: cd dist && sha256sum *.whl *.tar.gz > SHA256SUMS
      - uses: actions/upload-artifact@v4
        with:
          name: ${PYPI_GATE_ARTIFACT_NAME}
          path: dist/

  publish:
    needs: build
    runs-on: ubuntu-latest
    # Drydock is this environment's deployment-protection rule: the job stays
    # queued until the release is approved in Drydock.
    environment: "${environmentName}"
    permissions:
      id-token: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: ${PYPI_GATE_ARTIFACT_NAME}
          path: dist
      # Fail closed if the downloaded bytes drifted from what was reviewed.
      - run: cd dist && sha256sum --check --strict SHA256SUMS
      - run: rm dist/SHA256SUMS
      - uses: pypa/gh-action-pypi-publish@release/v1
`,
    notes: [
      `On PyPI, add a trusted publisher for \`${packageName}\`: this repository, \`drydock-pypi-release.yml\`, and the environment set to \`${environmentName}\`.`,
      "Delete any remaining PyPI API tokens for the project once the trusted publisher works, so the gated workflow is the only credentialed publish path.",
      `A large wheel matrix can upload one bounded artifact per distribution: name the shards \`${PYPI_GATE_ARTIFACT_NAME}-*\`. The release target created alongside this workflow is already pinned to PyPI, which is what makes those shard names match.`,
    ],
  };
}

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
