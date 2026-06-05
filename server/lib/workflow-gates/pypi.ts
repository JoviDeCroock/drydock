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

  async prepareReleaseCandidates(
    env: Cloudflare.Env,
    ctx: ExecutionContext,
    { bundle }: { bundle: ResolvedReleaseBundle },
  ): Promise<PreparedReleaseCandidate[]> {
    const entries: PreparedArtifactEntry[] = [];
    for (const file of bundle.artifacts) {
      const files = await parseArtifactBytes(env, ctx, file);
      const input: PyPiArtifactInput = { path: file.path, files };
      entries.push({ file, input, prepared: preparePyPiArtifact(input) });
    }
    return deriveReleaseCandidates(entries);
  },
};

interface PreparedArtifactEntry {
  file: ResolvedReleaseFile;
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
        `${entry.file.path} does not expose a PyPI Name/Version in its metadata`,
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
        `${entry.file.path} version ${summary.version} disagrees with ${group.version} for ${group.name}`,
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
      group.entries.map((entry) => entry.file),
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
  files: ResolvedReleaseFile[],
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
