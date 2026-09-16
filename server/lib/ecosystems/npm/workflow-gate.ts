import { buildNpmReleaseManifest, npmGateAdapter } from "./gate-review";
import { erasePackageAdapter } from "../package-adapter";
import { WorkflowArtifactError } from "../../github-app/artifacts";
import { buildManifestOrFail, groupReleaseCandidates } from "../../workflow-gates/group-candidates";
import type {
  ArchiveContents,
  ParsedGateArtifact,
  PreparedReleaseCandidate,
  WorkflowArtifactKind,
  WorkflowGateAdapter,
} from "../../workflow-gates/types";

/**
 * npm workflow-gate adapter.
 *
 * The release set is whatever `.tgz` tarballs the workflow uploaded (`npm pack`
 * output) — no maintainer-declared manifest. Identity (`package`/`version`) is
 * read from each tarball's `package.json` after the bytes are parsed in the
 * shared sandbox router, and the manifest is synthesized server-side with the
 * recomputed digest. Because an npm `.tgz` is indistinguishable from a PyPI
 * sdist by name, auto-detect targets route here by content (`detectArtifact`):
 * an archive that carries a root `package.json` is npm's.
 *
 * The deterministic review, baseline selection (through the org npm connection),
 * findings, and risk model are shared with the staged-publish path via
 * `npmGateAdapter` (`server/lib/ecosystems/npm/gate-review`).
 */
export const npmWorkflowGateAdapter: WorkflowGateAdapter = {
  ecosystem: "npm",
  // Matches the `actions/upload-artifact` name in the documented release flow,
  // but discovery does not require it — auto-detect inspects every upload.
  artifactName: "npm-release-candidates",
  packageAdapter: erasePackageAdapter(npmGateAdapter),

  classifyArtifact(path: string): WorkflowArtifactKind | null {
    const lower = path.toLowerCase();
    return lower.endsWith(".tgz") || lower.endsWith(".tar.gz") ? "tarball" : null;
  },

  detectArtifact(contents: ArchiveContents): WorkflowArtifactKind | null {
    // `package.json` is surfaced from the npm `package/` root by the sandbox
    // parser; a PyPI sdist never carries a root `package.json`.
    return contents.packageJson?.name ? "tarball" : null;
  },

  // Tarballs are grouped by `package.json` name (a monorepo's `npm run
  // pack:all` → `dist/*.tgz`). A single npm package version is exactly one
  // tarball, so a second tarball claiming the same name is rejected.
  prepareReleaseCandidates(artifacts: ParsedGateArtifact[]): PreparedReleaseCandidate[] {
    return groupReleaseCandidates(artifacts, {
      identity(artifact) {
        const name = artifact.packageJson?.name;
        const version = artifact.packageJson?.version;
        if (!name || !version) {
          throw new WorkflowArtifactError(
            "artifact_identity_missing",
            `${artifact.path} does not expose a package.json name/version`,
          );
        }
        return { key: name, name, version };
      },
      allowMultiplePerGroup: false,
      duplicateMessage: (identity) =>
        `package ${identity.name} has more than one tarball in this release`,
      buildManifest: (identity, [artifact]) =>
        buildManifestOrFail(
          () =>
            buildNpmReleaseManifest(identity.name, identity.version, [
              { path: artifact.path, sha256: artifact.sha256 },
            ]),
          "derived release identity is not valid",
        ),
      candidate: (manifest, [artifact]) => ({
        ecosystem: "npm",
        pipelineInput: {
          manifest,
          artifact: {
            path: artifact.path,
            sha256: artifact.sha256,
            files: artifact.files,
            packageJson: artifact.packageJson,
            ...(artifact.suspiciousEntries
              ? { suspiciousEntries: artifact.suspiciousEntries }
              : {}),
          },
        },
        package: { name: manifest.package, version: manifest.version },
      }),
    });
  },
};
