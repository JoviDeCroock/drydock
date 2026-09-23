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
import {
  GATE_SETUP_ACTIONS,
  GATE_SETUP_PINNING_NOTE,
} from "../../workflow-gates/gate-setup-actions";
import { buildManifestOrFail, groupReleaseCandidates } from "../../workflow-gates/group-candidates";
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

  gateSetupTemplate(input: GateSetupTemplateInput): GateSetupTemplate {
    return pypiGateSetupTemplate(input);
  },
};

/** PyPA's publish action, pinned like the shared actions in `gate-setup-actions.ts`. */
const PYPI_PUBLISH_ACTION =
  "pypa/gh-action-pypi-publish@dc37677b2e1c63e2034f94d8a5b11f265b73ba33 # v1.14.2";

/**
 * The PyPI publish workflow the setup wizard generates for a maintainer to
 * commit.
 *
 * Same contract as the canonical example in `docs/pypi-workflow-gate.md`: build
 * once, record `SHA256SUMS` in `dist/`, upload the whole directory, pause at
 * the gated environment, re-check the digests on download, and hand the
 * reviewed distributions to `pypa/gh-action-pypi-publish` over OIDC.
 * `SHA256SUMS` is removed just before publish so it is never uploaded to PyPI.
 *
 * It is the single-build shape. A platform wheel matrix uploads one shard per
 * leg and needs a publish job that downloads and checks every shard, which is
 * the sharded example in the same doc — not something this template emits.
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

# No token scope by default; each job asks for exactly what it needs.
permissions: {}

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: ${GATE_SETUP_ACTIONS.checkout}
        with:
          # The build runs third-party build backends; keep the token off disk.
          persist-credentials: false
      - uses: ${GATE_SETUP_ACTIONS.setupPython}
        with:
          python-version: "3.x"
      - run: python -m pip install build
      - run: python -m build
      # Record the digests Drydock reviews and the publish job re-checks.
      - run: cd dist && sha256sum *.whl *.tar.gz > SHA256SUMS
      - uses: ${GATE_SETUP_ACTIONS.uploadArtifact}
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
      # OIDC for PyPI trusted publishing; no API token exists in this workflow.
      id-token: write
    steps:
      - uses: ${GATE_SETUP_ACTIONS.downloadArtifact}
        with:
          name: ${PYPI_GATE_ARTIFACT_NAME}
          path: dist
      # Fail closed if the downloaded bytes drifted from what was reviewed.
      - run: cd dist && sha256sum --check --strict SHA256SUMS
      - run: rm dist/SHA256SUMS
      - uses: ${PYPI_PUBLISH_ACTION}
`,
    notes: [
      `On PyPI, add a trusted publisher for \`${packageName}\`: this repository, \`drydock-pypi-release.yml\`, and the environment set to \`${environmentName}\`.`,
      "Delete any remaining PyPI API tokens for the project once the trusted publisher works, so the gated workflow is the only credentialed publish path.",
      "This workflow builds once, on one runner. A platform wheel matrix needs the sharded shape in Drydock's PyPI gate docs instead: one upload per build leg, and a publish job that downloads and checks every shard.",
      GATE_SETUP_PINNING_NOTE,
    ],
  };
}

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
