import {
  buildBrowserReleaseManifest,
  createBrowserExtensionReview,
} from "../../server/lib/ecosystems/browser";

/** Run one synthetic browser-extension fixture through the production review path. */
export function createBrowserCorpusReview(fixture) {
  const path = fixture.artifactPath ?? `dist/${fixture.slug}.${fixture.artifactKind ?? "zip"}`;
  const manifest = buildBrowserReleaseManifest(fixture.extensionId, fixture.version, [
    { path, sha256: fixture.sha256 },
  ]);
  return createBrowserExtensionReview({
    manifest,
    artifact: { path, sha256: fixture.sha256, files: fixture.stagedFiles },
    ...(fixture.previousFiles
      ? {
          previousArtifact: {
            path,
            sha256: fixture.previousSha256,
            files: fixture.previousFiles,
          },
        }
      : {}),
  });
}
