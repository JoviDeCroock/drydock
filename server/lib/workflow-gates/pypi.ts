import {
  inferPyPiArtifactKind,
  normalizePyPiProjectName,
  parsePyPiReleaseManifest,
  preparePyPiArtifact,
  pypiAdapter,
  PYPI_RELEASE_MANIFEST_SCHEMA,
  type PyPiArtifactInput,
  type PyPiArtifactKind,
  type PyPiPreparedArtifact,
  type PyPiReleaseManifest,
} from "../adapters/pypi/index";
import type { AdapterBroker, PackageAdapter } from "../adapters/types";
import {
  type ResolvedReleaseBundle,
  type ResolvedReleaseFile,
  WorkflowArtifactError,
} from "../github-app";
import { downloadInSandboxInline, type DownloadResult } from "../sandbox";
import type { PreparedReleaseCandidate, WorkflowArtifactKind, WorkflowGateAdapter } from "./types";

/**
 * PyPI workflow-gate adapter.
 *
 * There is no maintainer-declared manifest: the release set is whatever
 * wheel/sdist files the bundle contains, and identity (`package`/`version`) is
 * derived from each wheel's `METADATA` / sdist's `PKG-INFO` after the bytes are
 * parsed in the credentials-free sandbox. The deterministic review + baseline
 * selection live in the shared `pypiAdapter` (`server/lib/adapters/pypi`); this
 * adapter only owns the gate-time artifact semantics.
 */
export const pypiWorkflowGateAdapter: WorkflowGateAdapter = {
  ecosystem: "pypi",
  artifactName: "pypi-release-candidate",
  packageAdapter: pypiAdapter as PackageAdapter<unknown, AdapterBroker>,

  classifyArtifact(path: string): WorkflowArtifactKind | null {
    return inferPyPiArtifactKind(path);
  },

  async prepareReleaseCandidate(
    env: Cloudflare.Env,
    ctx: ExecutionContext,
    { bundle }: { bundle: ResolvedReleaseBundle },
  ): Promise<PreparedReleaseCandidate> {
    const artifacts: PyPiArtifactInput[] = [];
    for (const artifact of bundle.artifacts) {
      const files = await parseArtifactBytes(env, ctx, artifact);
      artifacts.push({ path: artifact.path, files });
    }
    const prepared = artifacts.map(preparePyPiArtifact);
    const manifest = deriveReleaseManifest(bundle, prepared);

    return {
      pipelineInput: { manifest, artifacts },
      package: { name: manifest.package, version: manifest.version },
    };
  },
};

/**
 * Synthesize the `PyPiReleaseManifest` the rest of the pipeline consumes from
 * the artifacts themselves. Identity comes from each wheel's `METADATA` /
 * sdist's `PKG-INFO`, and the SHA-256 is the digest already recomputed from the
 * bundle bytes.
 *
 * Every artifact must expose a `Name`/`Version` and agree on the normalized
 * (PEP 503) name and the version, so a foreign or version-skewed file slipped
 * into the bundle is rejected rather than silently shipped.
 */
function deriveReleaseManifest(
  bundle: ResolvedReleaseBundle,
  prepared: PyPiPreparedArtifact[],
): PyPiReleaseManifest {
  let name: string | null = null;
  let normalizedName: string | null = null;
  let version: string | null = null;
  for (const artifact of prepared) {
    const { summary } = artifact;
    if (!summary.name || !summary.version) {
      throw new WorkflowArtifactError(
        "artifact_identity_missing",
        `${artifact.path} does not expose a PyPI Name/Version in its metadata`,
      );
    }
    const normalized = normalizePyPiProjectName(summary.name);
    if (name === null) {
      name = summary.name;
      normalizedName = normalized;
      version = summary.version;
      continue;
    }
    if (normalized !== normalizedName) {
      throw new WorkflowArtifactError(
        "artifact_identity_inconsistent",
        `${artifact.path} package ${summary.name} disagrees with ${name}`,
      );
    }
    if (summary.version !== version) {
      throw new WorkflowArtifactError(
        "artifact_identity_inconsistent",
        `${artifact.path} version ${summary.version} disagrees with ${version}`,
      );
    }
  }

  // `prepared` is non-empty: the resolver throws `bundle_empty` when a bundle
  // has no wheels/sdists, so `name`/`version` are always set here.
  const candidate = {
    schema: PYPI_RELEASE_MANIFEST_SCHEMA,
    ecosystem: "pypi",
    package: name,
    version,
    artifacts: bundle.artifacts.map((file) => ({ path: file.path, sha256: file.sha256 })),
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

async function parseArtifactBytes(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  artifact: ResolvedReleaseFile,
): Promise<DownloadResult["files"]> {
  const format = inlineFormatForKind(artifact.kind as PyPiArtifactKind);
  const result = await downloadInSandboxInline(env, ctx, {
    bytes: artifact.bytes,
    format,
  });
  return result.files;
}

function inlineFormatForKind(kind: PyPiArtifactKind): "zip" | "tgz" {
  return kind === "wheel" ? "zip" : "tgz";
}
