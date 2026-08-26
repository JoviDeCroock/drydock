import { isPkgPrNewUrl, parsePkgPrNewUrl } from "../../../../src/lib/pkg-pr-new";
import { publicDiffDownloadError } from "../../public-diff/download";
import { PublicDiffError } from "../../public-diff/error";
import { fetchPublicPackageMetadata } from "../../public-diff/metadata";
import type {
  PublicDiffAcquiredSources,
  PublicDiffAdapter,
  PublicDiffInput,
  PublicDiffVersionListing,
} from "../../public-diff/types";
import { DETERMINISTIC_RULES_VERSION } from "../../review";
import { parseSandboxErrorDetail } from "../../sandbox";
import { buildNpmFindings } from "./findings";
import {
  downloadPkgPrNewTarball,
  downloadPublishedTarball,
  isPublishedTarballUrlAllowed,
} from "./published-tarball";
import { compareSemver, isValidNpmPackageName } from "./registry";

export const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org";

const NPM_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

/**
 * Anonymous public diff for npm.
 *
 * Unique to npm: either side of the pair may be a [pkg.pr.new] continuous-release
 * preview URL instead of a published version, so a pull-request build can be
 * reviewed against a release before it ships. Preview refs are mutable, which is
 * why the orchestrator gives preview-involving pairs a short cache TTL and keeps
 * preview bytes out of the shared tarball-byte cache.
 */
export const npmPublicDiff: PublicDiffAdapter = {
  ecosystem: "npm",
  registryUrl: PUBLIC_NPM_REGISTRY,
  rulesVersionSegment: DETERMINISTIC_RULES_VERSION,
  // v4: two-tier sandbox entry cap — big archives now parse with hash-only
  // tails, and payloads carry acquisition notices; cached v3 pairs would
  // misrepresent both.
  // v5: oversized pairs retain samples for changed files instead of dropping
  // every sample, and mark the records that lost one. Entries written by v4
  // carry no sample at all for a pair this large, so they must not be served
  // once the prioritized retention ships.
  // v6: payloads carry the capability delta, per-side publication timestamps,
  // and declared source binding; v5 entries would serve none of them.
  payloadVersion: "v6",

  isValidPackageName: isValidNpmPackageName,
  normalizePackageName: (name) => name,
  isValidVersion: (version) => NPM_VERSION_RE.test(version) || isPkgPrNewUrl(version),
  // npm keeps the historical un-prefixed tag so existing purge tooling works.
  cacheTag: (packageName) => `public-diff:${packageName}`,

  async listVersions(env, ctx, packageName): Promise<PublicDiffVersionListing> {
    const metadata = await fetchPublicPackageMetadata(env, ctx, packageName, PUBLIC_NPM_REGISTRY);

    const tagsByVersion = new Map<string, string[]>();
    for (const [tag, version] of Object.entries(metadata["dist-tags"] ?? {})) {
      if (!version) continue;
      const list = tagsByVersion.get(version) ?? [];
      list.push(tag);
      tagsByVersion.set(version, list);
    }
    const times = metadata.time ?? {};
    const versions = Object.keys(metadata.versions ?? {})
      .sort((a, b) => compareSemver(b, a))
      .map((version) => ({
        version,
        distTags: (tagsByVersion.get(version) ?? []).sort(),
        publishedAt: typeof times[version] === "string" ? times[version] : undefined,
      }));

    const latest = metadata["dist-tags"]?.latest ?? versions[0]?.version ?? null;
    const previous = latest
      ? (versions.find(
          (entry) => entry.version !== latest && compareSemver(entry.version, latest) < 0,
        )?.version ?? null)
      : null;

    return {
      packageName,
      versions,
      suggested: latest && previous ? { from: previous, to: latest } : null,
    };
  },

  async acquire(env, ctx, input): Promise<PublicDiffAcquiredSources> {
    // Preview-side validation is fetch-free: a preview URL must name the same
    // package as the request.
    const fromPreview = parsePkgPrNewUrl(input.fromVersion);
    const toPreview = parsePkgPrNewUrl(input.toVersion);
    for (const preview of [fromPreview, toPreview]) {
      if (preview && preview.packageName !== input.packageName) {
        throw new PublicDiffError("preview URL is for a different package", 400);
      }
    }

    // Registry metadata is only needed for registry-version sides; a
    // preview-vs-preview pair may not be published on npm at all yet.
    let fromTarballUrl = fromPreview?.url;
    let toTarballUrl = toPreview?.url;
    let fromPublishedAt: string | undefined;
    let toPublishedAt: string | undefined;
    if (!fromTarballUrl || !toTarballUrl) {
      const metadata = await fetchPublicPackageMetadata(
        env,
        ctx,
        input.packageName,
        input.registryUrl,
      );
      fromTarballUrl ??= metadata.versions?.[input.fromVersion]?.dist?.tarball;
      toTarballUrl ??= metadata.versions?.[input.toVersion]?.dist?.tarball;
      // Publication times only exist for registry versions; a preview side
      // deliberately reports none.
      fromPublishedAt = fromPreview ? undefined : publishedTime(metadata.time, input.fromVersion);
      toPublishedAt = toPreview ? undefined : publishedTime(metadata.time, input.toVersion);
      if (!fromTarballUrl || !toTarballUrl) {
        throw new PublicDiffError("unknown version", 404);
      }
      for (const [tarballUrl, preview] of [
        [fromTarballUrl, fromPreview],
        [toTarballUrl, toPreview],
      ] as const) {
        if (
          !preview &&
          !isPublishedTarballUrlAllowed(
            tarballUrl,
            input.registryUrl,
            input.allowInsecureLocalhost ?? false,
          )
        ) {
          throw new PublicDiffError("registry returned an unexpected tarball URL", 502);
        }
      }
    }

    const [fromArchive, toArchive] = await Promise.all([
      fromPreview
        ? downloadPreviewArchive(env, ctx, fromPreview.url)
        : downloadArchive(env, ctx, fromTarballUrl, input),
      toPreview
        ? downloadPreviewArchive(env, ctx, toPreview.url)
        : downloadArchive(env, ctx, toTarballUrl, input),
    ]);

    return {
      from: {
        files: fromArchive.files,
        packageJson: fromArchive.packageJson ?? null,
        ...(fromPublishedAt ? { publishedAt: fromPublishedAt } : {}),
      },
      to: {
        files: toArchive.files,
        packageJson: toArchive.packageJson ?? null,
        ...(toPublishedAt ? { publishedAt: toPublishedAt } : {}),
      },
      buildFindings: (fileDiff, manifestDiff) =>
        buildNpmFindings({
          staged: {
            files: toArchive.files,
            manifest: toArchive.packageJson ?? null,
            suspiciousTarEntries: toArchive.suspiciousEntries,
          },
          details: null,
          fileDiff,
          manifestDiff,
          stagedManifestText:
            toArchive.files.find((file) => file.path === "package.json")?.textSample ?? null,
        }),
    };
  },
};

function publishedTime(
  time: Record<string, string> | undefined,
  version: string,
): string | undefined {
  const value = time?.[version];
  return typeof value === "string" && value ? value : undefined;
}

async function downloadArchive(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  tarballUrl: string,
  input: Pick<PublicDiffInput, "registryUrl" | "allowInsecureLocalhost">,
) {
  try {
    return await downloadPublishedTarball(env, ctx, tarballUrl, {
      registryUrl: input.registryUrl,
      allowInsecureLocalhost: input.allowInsecureLocalhost,
    });
  } catch (err) {
    throw publicDiffDownloadError(err);
  }
}

async function downloadPreviewArchive(env: Cloudflare.Env, ctx: ExecutionContext, url: string) {
  try {
    return await downloadPkgPrNewTarball(env, ctx, url);
  } catch (err) {
    // A preview ref that no longer resolves is the one failure the shared
    // mapping cannot name, because published tarball URLs come from registry
    // metadata and never 404 on their own.
    if (parseSandboxErrorDetail(err)?.status === 404) {
      throw new PublicDiffError("preview not found on pkg.pr.new", 404);
    }
    throw publicDiffDownloadError(err);
  }
}
