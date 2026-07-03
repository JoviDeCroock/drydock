import {
  GO_RELEASE_MANIFEST_SCHEMA,
  goAdapter,
  inferGoArtifactKind,
  parseGoModuleZipRoot,
  parseGoReleaseManifest,
  prepareGoArtifact,
  type GoArtifactInput,
  type GoPreparedArtifact,
  type GoReleaseManifest,
} from "../adapters/gomod/index";
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
 * Go modules workflow-gate adapter.
 *
 * Go has no publish step — the "release" is the tag plus the module proxy's
 * first fetch — so the gate pauses the tag/release workflow instead of an
 * upload. The reviewable artifact is the module zip the workflow builds (e.g.
 * `go mod pack`-style zips produced with `golang.org/x/mod/zip`); identity
 * comes from the zip's mandatory `{module}@{version}/` root and its `go.mod`.
 * The deterministic review and proxy.golang.org baseline live in the shared
 * `goAdapter` (`server/lib/adapters/gomod`); this adapter only owns the
 * gate-time artifact semantics.
 */
export const goWorkflowGateAdapter: WorkflowGateAdapter = {
  ecosystem: "go",
  artifactName: "go-release-candidate",
  packageAdapter: goAdapter as PackageAdapter<unknown, AdapterBroker>,

  classifyArtifact(path: string): WorkflowArtifactKind | null {
    return inferGoArtifactKind(path);
  },

  detectArtifact(contents: ArchiveContents): WorkflowArtifactKind | null {
    // Every valid module zip roots all files under a single
    // `{module}@{version}/` directory; nothing else produces that shape.
    return parseGoModuleZipRoot(contents.files) ? "module" : null;
  },

  prepareReleaseCandidates(artifacts: ParsedGateArtifact[]): PreparedReleaseCandidate[] {
    const entries: PreparedArtifactEntry[] = artifacts.map((artifact) => {
      const input: GoArtifactInput = {
        path: artifact.path,
        files: artifact.files,
        ...(artifact.suspiciousEntries ? { suspiciousEntries: artifact.suspiciousEntries } : {}),
      };
      return { artifact, input, prepared: prepareGoArtifact(input) };
    });
    return deriveReleaseCandidates(entries);
  },
};

interface PreparedArtifactEntry {
  artifact: ParsedGateArtifact;
  input: GoArtifactInput;
  prepared: GoPreparedArtifact;
}

/**
 * Split the bundle's module zips into one candidate per distinct module.
 *
 * A multi-module repository can tag several modules from one release, so zips
 * are grouped by the module path parsed from their `{module}@{version}/` root
 * and each group becomes its own candidate → its own scan against its own
 * baseline. Every zip must expose that root, and a single module version is
 * exactly one zip, so an identity-less or duplicated zip is rejected rather
 * than silently shipped.
 */
function deriveReleaseCandidates(entries: PreparedArtifactEntry[]): PreparedReleaseCandidate[] {
  const groups = new Map<string, { version: string; entries: PreparedArtifactEntry[] }>();
  for (const entry of entries) {
    const { module } = entry.prepared.summary;
    if (!module.rootModulePath || !module.rootVersion) {
      throw new WorkflowArtifactError(
        "artifact_identity_missing",
        `${entry.artifact.path} does not expose a {module}@{version} zip root`,
      );
    }
    const group = groups.get(module.rootModulePath);
    if (!group) {
      groups.set(module.rootModulePath, { version: module.rootVersion, entries: [entry] });
      continue;
    }
    if (module.rootVersion !== group.version) {
      throw new WorkflowArtifactError(
        "artifact_identity_inconsistent",
        `${entry.artifact.path} version ${module.rootVersion} disagrees with ${group.version} for ${module.rootModulePath}`,
      );
    }
    // A single module version maps to exactly one zip; two zips claiming the
    // same module+version is ambiguous and must not ship.
    throw new WorkflowArtifactError(
      "artifact_identity_inconsistent",
      `module ${module.rootModulePath} has more than one zip in this release`,
    );
  }

  // `entries` is non-empty: the resolver throws `bundle_empty` for a bundle
  // with no reviewable artifacts, so `groups` always has at least one module.
  return [...groups.entries()].map(([modulePath, group]) => {
    const manifest = buildReleaseManifest(
      modulePath,
      group.version,
      group.entries.map((entry) => entry.artifact),
    );
    return {
      ecosystem: "go",
      pipelineInput: { manifest, artifacts: group.entries.map((entry) => entry.input) },
      package: { name: manifest.package, version: manifest.version },
    };
  });
}

function buildReleaseManifest(
  modulePath: string,
  version: string,
  files: ParsedGateArtifact[],
): GoReleaseManifest {
  const candidate = {
    schema: GO_RELEASE_MANIFEST_SCHEMA,
    ecosystem: "go",
    package: modulePath,
    version,
    artifacts: files.map((file) => ({ path: file.path, sha256: file.sha256 })),
  };
  try {
    return parseGoReleaseManifest(candidate);
  } catch (err) {
    throw new WorkflowArtifactError(
      "artifact_identity_missing",
      err instanceof Error ? err.message : "derived release identity is not valid",
    );
  }
}
