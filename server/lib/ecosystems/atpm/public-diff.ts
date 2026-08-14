import { atpmRecordFindings } from "./findings";
import {
  isValidAtpmPackageName,
  normalizeAtpmPackageName,
  parseAtpmPackageName,
  resolveAtpmRepoIdentity,
  type AtpmPackageRef,
  type AtpmRepoIdentity,
} from "./identity";
import {
  ATPM_PACKAGE_COLLECTION,
  ATPM_RULES_VERSION,
  assertAtpmBlobDigest,
  atpmBlobUrl,
  fetchAtpmPackageRecord,
  isValidAtpmVersion,
  listAtpmVersions,
  requireAtpmVersion,
  type AtpmPackage,
  type AtpmVersion,
} from "./record";
import { buildNpmFindings } from "../npm/findings";
import {
  computeCompareMetadataCacheKey,
  readCompareMetadataCache,
  writeCompareMetadataCache,
} from "../../compare-cache";
import { publicDiffDownloadError } from "../../public-diff/download";
import { PublicDiffError } from "../../public-diff/error";
import type {
  PublicDiffAcquiredSources,
  PublicDiffAdapter,
  PublicDiffProvenanceEntry,
} from "../../public-diff/types";
import { DETERMINISTIC_RULES_VERSION } from "../../review";
import {
  downloadInSandbox,
  SANDBOX_MAX_STREAM_TAR_BYTES,
  type DownloadResult,
} from "../../sandbox";

/**
 * atpm's public-diff capability — the anonymous `/diff` surface for packages
 * published to the AT Protocol.
 *
 * There is no registry here to fetch from. `registryUrl` names the protocol
 * rather than a host, because a diff of two atpm versions may touch a different
 * set of hosts for every package: the publisher's own domain or the PLC
 * directory for identity, and the publisher's PDS for the record and the bytes.
 * See `./identity.ts` for why none of that goes through atpm.dev.
 *
 * A version is otherwise an ordinary npm tarball, so it runs the npm rule set
 * unchanged and adds only the checks that atpm's split of metadata-from-artifact
 * makes possible (`./findings.ts`).
 */
const ATPM_PROTOCOL = "at://";

const PUBLIC_CACHE_SCOPE = "atpm-public";
const ATPM_PAIR_CACHE_TTL_SECONDS = 5 * 60;

export const atpmPublicDiff: PublicDiffAdapter = {
  ecosystem: "atpm",
  registryUrl: ATPM_PROTOCOL,
  rulesVersionSegment: `${DETERMINISTIC_RULES_VERSION}+atpm-${ATPM_RULES_VERSION}`,
  // v3: atpm pairs use a bounded cache lifetime because an AT repository record,
  // its PDS location, and its verified display handle may all change. Old v2
  // entries were written with the registry-default 30-day lifetime.
  payloadVersion: "v3",
  cacheTtlSeconds: ATPM_PAIR_CACHE_TTL_SECONDS,

  isValidPackageName: isValidAtpmPackageName,
  normalizePackageName: normalizeAtpmPackageName,
  // Versions come from the record's own strings and use npm's grammar; the
  // shared predicate also filters the version listing before it reaches the UI.
  isValidVersion: isValidAtpmVersion,
  cacheTag: (packageName) => `public-diff:atpm:${packageName}`,

  async listVersions(env, ctx, packageName) {
    const { ref, identity, pkg } = await loadAtpmPackage(env, ctx, packageName);
    const { versions, suggested } = listAtpmVersions(pkg);
    return { ...canonicalNames(ref, identity), versions, suggested };
  },

  async acquire(env, ctx, input) {
    const { ref, identity, pkg } = await loadAtpmPackage(env, ctx, input.packageName);
    const from = requireAtpmVersion(pkg, input.fromVersion);
    const to = requireAtpmVersion(pkg, input.toVersion);

    const [fromArchive, toArchive] = await Promise.all([
      downloadAtpmBlob(env, ctx, identity, from),
      downloadAtpmBlob(env, ctx, identity, to),
    ]);

    const { displayName } = canonicalNames(ref, identity);
    return {
      from: { files: fromArchive.files, packageJson: fromArchive.packageJson ?? null },
      to: { files: toArchive.files, packageJson: toArchive.packageJson ?? null },
      provenance: resolutionTrail(ref, identity),
      ...(displayName ? { displayName } : {}),
      buildFindings: (fileDiff, manifestDiff) => [
        // The artifact is an npm tarball, so it gets the npm rule set verbatim.
        // `details` stays null: those findings describe an npm stage record,
        // which has no counterpart here — the atpm equivalent is below.
        ...buildNpmFindings({
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
        ...atpmRecordFindings({
          entry: to,
          manifest: toArchive.packageJson ?? null,
          archiveSha1: toArchive.archiveSha1 ?? null,
          recordName: ref.name,
        }),
      ],
    } satisfies PublicDiffAcquiredSources;
  },
};

interface LoadedAtpmPackage {
  ref: AtpmPackageRef;
  identity: AtpmRepoIdentity;
  pkg: AtpmPackage;
}

/**
 * Resolve a package name all the way to its record.
 *
 * Both halves are cached under the shared compare-metadata TTL (minutes), which
 * is the right bound for each: identity resolution is several round trips to
 * DNS, a directory, and a web server before any package data is read, and the
 * record is one mutable object whose version-to-CID mapping, verified handle,
 * and PDS location can change. Computed atpm pairs therefore use the same
 * five-minute freshness bound instead of the registry-default 30 days.
 */
async function loadAtpmPackage(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  packageName: string,
): Promise<LoadedAtpmPackage> {
  const ref = parseAtpmPackageName(packageName);
  if (!ref) throw new PublicDiffError("invalid package name", 400);

  const identity = await resolveIdentityCached(env, ctx, ref);
  const pkg = await fetchRecordCached(env, ctx, ref, identity);
  return { ref, identity, pkg };
}

async function resolveIdentityCached(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  ref: AtpmPackageRef,
): Promise<AtpmRepoIdentity> {
  // Keyed by the authority, not the package: every package a publisher ships
  // resolves through the same identity.
  const authority =
    ref.authority.kind === "handle" ? `@${ref.authority.handle}` : ref.authority.did;
  const key = await identityCacheKey(authority);
  const cached = await readCompareMetadataCache<AtpmRepoIdentity>(env, key);
  if (cached) return cached;

  const identity = await resolveAtpmRepoIdentity(ref);
  const writes = [writeCompareMetadataCache(env, ctx, key, identity)];
  // Store the same result under the DID too. Typing a handle into /diff
  // redirects to the DID form, which would otherwise miss this cache and redo
  // the whole chain — including the reverse handle lookup that a DID-addressed
  // resolution needs and this one already did in the forward direction.
  if (ref.authority.kind === "handle") {
    writes.push(
      identityCacheKey(identity.did).then((didKey) =>
        writeCompareMetadataCache(env, ctx, didKey, identity),
      ),
    );
  }
  await Promise.all(writes);
  return identity;
}

function identityCacheKey(authority: string): Promise<string> {
  return computeCompareMetadataCacheKey({
    registryUrl: ATPM_PROTOCOL,
    packageName: authority,
    cacheScope: `${PUBLIC_CACHE_SCOPE}-identity`,
  });
}

async function fetchRecordCached(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  ref: AtpmPackageRef,
  identity: AtpmRepoIdentity,
): Promise<AtpmPackage> {
  // Keyed by DID rather than by the name as typed, so the handle form and the
  // DID form of one package share a single cached record.
  const key = await computeCompareMetadataCacheKey({
    registryUrl: ATPM_PROTOCOL,
    packageName: `${identity.did}/${ref.name}`,
    cacheScope: `${PUBLIC_CACHE_SCOPE}-record`,
  });
  const cached = await readCompareMetadataCache<AtpmPackage>(env, key);
  if (cached) return cached;

  const pkg = await fetchAtpmPackageRecord(identity, ref.name);
  await writeCompareMetadataCache(env, ctx, key, pkg);
  return pkg;
}

/**
 * The two names a resolved atpm package has.
 *
 * Canonical is always the DID form, whichever way the request spelled it, so
 * that is what `/diff` redirects to and what ends up in a shared URL: a DID is
 * permanent, while a handle is rented and can move to another account — a
 * handle-form link would then quietly start describing a different package.
 *
 * Display is the `@handle/name` form, present only when this resolution proved
 * the handle in both directions. It is what the page shows, so pinning the
 * identity in the URL does not cost the reader a name they recognize.
 */
function canonicalNames(
  ref: AtpmPackageRef,
  identity: AtpmRepoIdentity,
): { packageName: string; displayName?: string } {
  return {
    packageName: `${identity.did}/${ref.name}`,
    ...(identity.handle ? { displayName: `@${identity.handle}/${ref.name}` } : {}),
  };
}

/**
 * The chain of independent authorities this diff actually went through, shown
 * on the page. On npm this would be noise — there is one registry and everyone
 * knows its name — but here it is the answer to "who says these are the bytes",
 * and every step is separately checkable by the reader.
 */
function resolutionTrail(
  ref: AtpmPackageRef,
  identity: AtpmRepoIdentity,
): PublicDiffProvenanceEntry[] {
  const trail: PublicDiffProvenanceEntry[] = [];
  if (identity.handle) {
    trail.push({
      label: "Handle",
      value: `@${identity.handle}`,
      detail: identity.handleMethod === "dns" ? "DNS TXT" : "/.well-known/atproto-did",
    });
  }
  trail.push({
    label: "DID",
    value: identity.did,
    detail: identity.did.startsWith("did:plc:") ? "plc.directory" : "did:web",
  });
  trail.push({ label: "PDS", value: new URL(identity.pds).host });
  // The full AT-URI, so a reader can paste it into any atproto client and read
  // the same record this diff was built from.
  trail.push({
    label: "Record",
    value: `${ATPM_PROTOCOL}${identity.did}/${ATPM_PACKAGE_COLLECTION}/${ref.name}`,
  });
  return trail;
}

/**
 * Fetch and parse one version's tarball.
 *
 * The bytes go straight to the credentials-free sandbox with the blob URL pinned
 * as the single allowed egress, exactly as PyPI's public path does. Nothing in
 * this flow ever holds an npm token, so there is no credential the sandbox could
 * leak even if the archive were malicious.
 */
async function downloadAtpmBlob(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  identity: AtpmRepoIdentity,
  entry: AtpmVersion,
): Promise<DownloadResult> {
  // The record advertises the blob's size, so an oversized release can be
  // refused before a byte is fetched instead of after the sandbox gives up.
  if (entry.size !== null && entry.size > SANDBOX_MAX_STREAM_TAR_BYTES) {
    throw new PublicDiffError("release artifact exceeds the public diff size limit", 413);
  }
  const url = atpmBlobUrl(identity, entry.cid);
  let archive: DownloadResult;
  try {
    archive = await downloadInSandbox(env, ctx, {
      tarballUrl: url,
      archiveFormat: "tgz",
      publicArtifactUrls: [url],
    });
  } catch (err) {
    throw publicDiffDownloadError(err);
  }
  assertAtpmBlobDigest(entry.cid, archive.archiveSha256 ?? null);
  return archive;
}
