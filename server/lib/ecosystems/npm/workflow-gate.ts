import { buildNpmReleaseManifest, npmGateAdapter } from "./gate-review";
import { createNpmBroker } from "./broker";
import { allowInsecureLocalRegistry } from "./connection";
import { downloadPublishedTarball } from "./published-tarball";
import { fetchPackageMetadataCached } from "./registry-cache";
import type { AdapterBroker, PackageAdapter } from "../package-adapter";
import { WorkflowArtifactError } from "../../github-app/artifacts";
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
  packageAdapter: npmGateAdapter as unknown as PackageAdapter<unknown, AdapterBroker>,

  classifyArtifact(path: string): WorkflowArtifactKind | null {
    const lower = path.toLowerCase();
    return lower.endsWith(".tgz") || lower.endsWith(".tar.gz") ? "tarball" : null;
  },

  detectArtifact(contents: ArchiveContents): WorkflowArtifactKind | null {
    // `package.json` is surfaced from the npm `package/` root by the sandbox
    // parser; a PyPI sdist never carries a root `package.json`.
    return contents.packageJson?.name ? "tarball" : null;
  },

  prepareReleaseCandidates(artifacts: ParsedGateArtifact[]): PreparedReleaseCandidate[] {
    return deriveNpmReleaseCandidates(artifacts);
  },

  async verifyPublishedRelease(ctx, input) {
    const broker = createNpmBroker(
      { ...ctx, session: { userId: "registry-verification" } },
      { organizationId: ctx.organizationId },
    );
    try {
      let published: Awaited<ReturnType<typeof downloadPublishedTarball>> | undefined;
      try {
        const metadata = await broker.fetchPackageMetadata(input.packageName);
        const tarballUrl = metadata?.versions?.[input.version]?.dist?.tarball;
        if (tarballUrl) published = await broker.downloadPublished(tarballUrl, { maxFiles: 1 });
      } catch {
        // A public gate does not require an organization npm connection. Fall
        // through to the credential-free registry path; private registries can
        // still verify through the broker above when a connection exists.
      }
      if (!published) {
        const metadata = await fetchPackageMetadataCached(ctx.env, ctx.executionCtx, {
          packageName: input.packageName,
          registryUrl: ctx.env.NPM_REGISTRY,
          cacheScope: "registry-verification:public",
          abbreviated: true,
        });
        const tarballUrl = metadata.versions?.[input.version]?.dist?.tarball;
        if (!tarballUrl) return { status: "not_published" };
        published = await downloadPublishedTarball(ctx.env, ctx.executionCtx, tarballUrl, {
          registryUrl: ctx.env.NPM_REGISTRY,
          allowInsecureLocalhost: allowInsecureLocalRegistry(ctx.env),
          maxFiles: 1,
        });
      }
      if (!published.archiveSha256) throw new Error("published npm tarball digest unavailable");
      const reviewedDigests = input.artifacts.map((artifact) => artifact.sha256).sort();
      const publishedDigests = [published.archiveSha256.toLowerCase()];
      return reviewedDigests.length === 1 && reviewedDigests[0] === publishedDigests[0]
        ? { status: "verified" }
        : { status: "mismatch", reviewedDigests, publishedDigests };
    } finally {
      await broker.dispose();
    }
  },
};

interface NpmGroup {
  name: string;
  version: string;
  artifacts: ParsedGateArtifact[];
}

/**
 * Split the bundle's npm tarballs into one candidate per distinct package.
 *
 * A monorepo publishes several packages from one release (e.g. `npm run
 * pack:all` → `dist/*.tgz`), so tarballs are grouped by their `package.json`
 * name and each group becomes its own candidate → its own scan against its own
 * baseline. Every tarball must expose a `name`/`version`; tarballs sharing a
 * name must agree on the version (and a single npm package version is exactly
 * one tarball), so a smuggled or version-skewed tarball is rejected rather than
 * silently shipped.
 */
function deriveNpmReleaseCandidates(artifacts: ParsedGateArtifact[]): PreparedReleaseCandidate[] {
  const groups = new Map<string, NpmGroup>();
  for (const artifact of artifacts) {
    const name = artifact.packageJson?.name;
    const version = artifact.packageJson?.version;
    if (!name || !version) {
      throw new WorkflowArtifactError(
        "artifact_identity_missing",
        `${artifact.path} does not expose a package.json name/version`,
      );
    }
    const group = groups.get(name);
    if (!group) {
      groups.set(name, { name, version, artifacts: [artifact] });
      continue;
    }
    if (version !== group.version) {
      throw new WorkflowArtifactError(
        "artifact_identity_inconsistent",
        `${artifact.path} version ${version} disagrees with ${group.version} for ${name}`,
      );
    }
    // A single published npm version maps to exactly one tarball; two tarballs
    // claiming the same name+version is ambiguous and must not ship.
    throw new WorkflowArtifactError(
      "artifact_identity_inconsistent",
      `package ${name} has more than one tarball in this release`,
    );
  }

  // `artifacts` is non-empty: the resolver throws `bundle_empty` for a bundle
  // with no reviewable artifacts, so `groups` always has at least one package.
  return [...groups.values()].map((group) => {
    const artifact = group.artifacts[0];
    const manifest = buildManifest(group.name, group.version, artifact);
    return {
      ecosystem: "npm",
      pipelineInput: {
        manifest,
        artifact: {
          path: artifact.path,
          sha256: artifact.sha256,
          files: artifact.files,
          packageJson: artifact.packageJson,
          ...(artifact.suspiciousEntries ? { suspiciousEntries: artifact.suspiciousEntries } : {}),
        },
      },
      package: { name: manifest.package, version: manifest.version },
    };
  });
}

function buildManifest(name: string, version: string, artifact: ParsedGateArtifact) {
  try {
    return buildNpmReleaseManifest(name, version, [
      { path: artifact.path, sha256: artifact.sha256 },
    ]);
  } catch (err) {
    throw new WorkflowArtifactError(
      "artifact_identity_missing",
      err instanceof Error ? err.message : "derived release identity is not valid",
    );
  }
}
