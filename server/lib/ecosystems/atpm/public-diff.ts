import { assertAtpmBaselineMetadata, atpmRecordFindings } from "./findings";
import {
  ATPM_IDENTITY_RULES_VERSION,
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
  assertAtpmArchiveIntegrity,
  assertAtpmBlobDigest,
  assertAtpmTarballUrl,
  atpmBlobUrl,
  fetchAtpmPackageRecord,
  isValidAtpmVersion,
  listAtpmVersions,
  requireAtpmVersion,
  type AtpmPackage,
  type AtpmVersion,
} from "./record";
import { ATPM_PROVENANCE_RULES_VERSION, atpmPurl } from "./provenance";
import { fetchAtpmStagedVersion, type AtpmStagedVersion } from "./stage-record";
import {
  ATPM_NO_BASELINE_VERSION,
  isAtpmStagedVersion,
  parseAtpmStagedVersion,
  type AtpmStagedVersionRef,
} from "./stage-ref";
import {
  ATPM_TRUST_PUBLISHER_RULES_VERSION,
  fetchAtpmTrustPublisher,
  matchTrustedPublisher,
  trustedPublisherRepositoryUri,
  type AtpmTrustPublisher,
} from "./trust-publisher";
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
  PublicDiffAttestation,
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
const ATPM_CACHE_ENVELOPE_VERSION = "absolute-expiry-v1";
const DID_WEB_NOTICE =
  "This publisher uses did:web, whose control follows the domain. The canonical URL pins the current DID spelling but cannot permanently pin publisher ownership.";

export const atpmPublicDiff: PublicDiffAdapter = {
  ecosystem: "atpm",
  registryUrl: ATPM_PROTOCOL,
  rulesVersionSegment: `${DETERMINISTIC_RULES_VERSION}+atpm-${ATPM_RULES_VERSION}+identity-${ATPM_IDENTITY_RULES_VERSION}+provenance-${ATPM_PROVENANCE_RULES_VERSION}+publisher-${ATPM_TRUST_PUBLISHER_RULES_VERSION}`,
  // v6 distinguishes a valid bundle that describes another artifact from one
  // that is bound to the release. v5 added the verified build attestation. v4 carried the
  // metadata resolution's absolute expiry through every cache layer; old v3
  // values could restart their five-minute TTL when re-warmed.
  // v7 lets a staged candidate stand in the `to` slot, which is how the
  // anonymous staged review reuses this whole surface.
  payloadVersion: "v7",
  cacheTtlSeconds: ATPM_PAIR_CACHE_TTL_SECONDS,

  isValidPackageName: isValidAtpmPackageName,
  normalizePackageName: normalizeAtpmPackageName,
  // A version slot holds a published version, a staged candidate, or the
  // no-baseline sentinel a first release uses on the left. All three share one
  // grammar so nothing downstream — routes, cache keys, share cards — has to
  // learn that a staged review is a different kind of thing.
  isValidVersion: (version) =>
    isValidAtpmVersion(version) ||
    isAtpmStagedVersion(version) ||
    version === ATPM_NO_BASELINE_VERSION,
  cacheTag: (packageName) => `public-diff:atpm:${packageName}`,

  async listVersions(env, ctx, packageName) {
    const { ref, identity, pkg, cacheExpiresAt } = await loadAtpmPackage(env, ctx, packageName);
    const { versions, suggested } = listAtpmVersions(pkg);
    return { ...canonicalNames(ref, identity), versions, suggested, cacheExpiresAt };
  },

  async acquire(env, ctx, input) {
    const { ref, identity, pkg, cacheExpiresAt } = await loadAtpmPackage(
      env,
      ctx,
      input.packageName,
    );
    const staged = parseAtpmStagedVersion(input.toVersion);
    const to = staged
      ? await resolveStagedEntry(identity, ref, staged)
      : requireAtpmVersion(pkg, input.toVersion);
    // A first release has nothing published to compare against. That is a real
    // state of the world rather than an error, so it renders as an empty left
    // side — every file added — with a notice saying why.
    const from =
      input.fromVersion === ATPM_NO_BASELINE_VERSION
        ? null
        : requireAtpmVersion(pkg, input.fromVersion);

    const [fromArchive, toArchive, publisher] = await Promise.all([
      from ? downloadAtpmBlob(env, ctx, identity, from) : Promise.resolve(null),
      downloadAtpmBlob(env, ctx, identity, to),
      loadTrustPublisherCached(env, ctx, identity, ref),
    ]);

    if (from && fromArchive) {
      assertAtpmBaselineMetadata({
        entry: from,
        manifest: fromArchive.packageJson ?? null,
        archiveSha1: fromArchive.archiveSha1 ?? null,
        recordName: ref.name,
      });
    }

    const { displayName } = canonicalNames(ref, identity);
    const pageNotices = reviewNotices({
      identity,
      staged: staged !== null,
      withoutBaseline: from === null,
    });
    return {
      from: {
        files: fromArchive?.files ?? [],
        packageJson: fromArchive?.packageJson ?? null,
      },
      to: { files: toArchive.files, packageJson: toArchive.packageJson ?? null },
      provenance: resolutionTrail(ref, identity),
      attestation: describeAttestation(to, publisher.value, toArchive.archiveSha512 ?? null),
      ...(pageNotices.length ? { notices: pageNotices } : {}),
      ...(displayName ? { displayName } : {}),
      cacheExpiresAt: earliestExpiry(cacheExpiresAt, publisher.expiresAt),
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
          archiveSha512: toArchive.archiveSha512 ?? null,
          recordName: ref.name,
          trustPublisher: publisher.value,
          baseline: from,
        }),
      ],
    } satisfies PublicDiffAcquiredSources;
  },
};

/**
 * Resolve a staged candidate into the same shape a published version has.
 *
 * The record's own CID is required to match the one in the URL. A staged record
 * is mutable, so without that check a link would silently start describing
 * whatever the publisher wrote most recently — on a page whose entire claim is
 * "these are the bytes", that is the one kind of staleness that must not be
 * possible. A rewritten candidate gets a different URL, and this one 404s.
 */
async function resolveStagedEntry(
  identity: AtpmRepoIdentity,
  ref: AtpmPackageRef,
  staged: AtpmStagedVersionRef,
): Promise<AtpmVersion> {
  const candidate = await fetchAtpmStagedVersion(identity, staged.rkey);
  if (candidate.recordCid !== staged.recordCid) {
    throw new PublicDiffError("this staged release has been replaced", 404);
  }
  // The candidate's own name has to be the package this URL addresses, or the
  // page would render one package's review under another's identity.
  if (recordNameOf(candidate.declaredName) !== ref.name) {
    throw new PublicDiffError("staged release is for a different package", 404);
  }
  return stagedAsVersion(candidate);
}

function recordNameOf(packageName: string): string | null {
  const slash = packageName.indexOf("/");
  return packageName.startsWith("@") && slash > 1 && slash === packageName.lastIndexOf("/")
    ? packageName.slice(slash + 1)
    : null;
}

/**
 * Project a staged record onto `AtpmVersion` so every downstream check — digest,
 * metadata, provenance, blob download — runs against a candidate exactly as it
 * runs against a release. A candidate that passes here is one that will still
 * pass after approval, because approval copies these same fields across.
 */
function stagedAsVersion(candidate: AtpmStagedVersion): AtpmVersion {
  return {
    version: candidate.version,
    cid: candidate.cid,
    size: candidate.size,
    mimeType: null,
    createdAt: candidate.createdAt,
    declaredName: candidate.declaredName,
    declaredVersion: candidate.declaredVersion,
    declaredShasum: candidate.declaredShasum,
    declaredTarball: candidate.declaredTarball,
    declaredIntegrity: candidate.declaredIntegrity,
    provenance: candidate.provenance,
  };
}

function reviewNotices(args: {
  identity: AtpmRepoIdentity;
  staged: boolean;
  withoutBaseline: boolean;
}): string[] {
  const notices: string[] = [];
  if (args.staged) {
    notices.push(
      "This release is staged and not yet published. Approving it publishes exactly these bytes — the candidate is pinned by content address, so nothing is rebuilt in between.",
    );
  }
  if (args.withoutBaseline) {
    notices.push(
      "This is the first release of this package, so there is nothing published to compare against and every file reads as added.",
    );
  }
  if (args.identity.did.startsWith("did:web:")) notices.push(DID_WEB_NOTICE);
  return notices;
}

interface LoadedAtpmPackage {
  ref: AtpmPackageRef;
  identity: AtpmRepoIdentity;
  pkg: AtpmPackage;
  cacheExpiresAt: string;
}

interface AtpmCacheEnvelope<T> {
  value: T;
  expiresAt: string;
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
  const pkg = await fetchRecordCached(env, ctx, ref, identity.value);
  return {
    ref,
    identity: identity.value,
    pkg: pkg.value,
    cacheExpiresAt: earliestExpiry(identity.expiresAt, pkg.expiresAt),
  };
}

async function resolveIdentityCached(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  ref: AtpmPackageRef,
): Promise<AtpmCacheEnvelope<AtpmRepoIdentity>> {
  // Keyed by the authority, not the package: every package a publisher ships
  // resolves through the same identity.
  const authority =
    ref.authority.kind === "handle" ? `@${ref.authority.handle}` : ref.authority.did;
  const key = await identityCacheKey(authority);
  const cached = await readCompareMetadataCache<AtpmCacheEnvelope<AtpmRepoIdentity>>(env, key);
  if (isFreshEnvelope(cached)) return cached;

  const identity = await resolveAtpmRepoIdentity(ref);
  const envelope = cacheEnvelope(identity);
  const writes = [writeCompareMetadataCache(env, ctx, key, envelope)];
  // Store the same result under the DID too. Typing a handle into /diff
  // redirects to the DID form, which would otherwise miss this cache and redo
  // the whole chain — including the reverse handle lookup that a DID-addressed
  // resolution needs and this one already did in the forward direction.
  if (ref.authority.kind === "handle") {
    writes.push(
      identityCacheKey(identity.did).then((didKey) =>
        writeCompareMetadataCache(env, ctx, didKey, envelope),
      ),
    );
  }
  await Promise.all(writes);
  return envelope;
}

function identityCacheKey(authority: string): Promise<string> {
  return computeCompareMetadataCacheKey({
    registryUrl: ATPM_PROTOCOL,
    packageName: authority,
    cacheScope: `${PUBLIC_CACHE_SCOPE}-identity-${ATPM_IDENTITY_RULES_VERSION}-${ATPM_CACHE_ENVELOPE_VERSION}`,
  });
}

async function fetchRecordCached(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  ref: AtpmPackageRef,
  identity: AtpmRepoIdentity,
): Promise<AtpmCacheEnvelope<AtpmPackage>> {
  // Keyed by DID rather than by the name as typed, so the handle form and the
  // DID form of one package share a single cached record.
  const key = await computeCompareMetadataCacheKey({
    registryUrl: ATPM_PROTOCOL,
    packageName: `${identity.did}/${ref.name}`,
    // Parsing is part of the trust boundary. A rules bump must not revive a
    // record reduced under older ambiguity or validation semantics.
    cacheScope: `${PUBLIC_CACHE_SCOPE}-record-${ATPM_RULES_VERSION}-${ATPM_CACHE_ENVELOPE_VERSION}`,
  });
  const cached = await readCompareMetadataCache<AtpmCacheEnvelope<AtpmPackage>>(env, key);
  if (isFreshEnvelope(cached)) return cached;

  const pkg = await fetchAtpmPackageRecord(identity, ref.name);
  const envelope = cacheEnvelope(pkg);
  await writeCompareMetadataCache(env, ctx, key, envelope);
  return envelope;
}

/**
 * Read the package's trusted-publisher declaration, cached like the record it
 * sits beside.
 *
 * A fetch failure is deliberately not degraded to "no declaration". The
 * declaration is what a build-provenance mismatch is measured against, so a PDS
 * that answers this one request with an error would otherwise be able to
 * suppress exactly the finding it should produce. A record that exists but does
 * not parse is a different case and is handled inside the fetch: nothing can be
 * concluded from an unreadable declaration either way.
 */
async function loadTrustPublisherCached(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  identity: AtpmRepoIdentity,
  ref: AtpmPackageRef,
): Promise<AtpmCacheEnvelope<AtpmTrustPublisher | null>> {
  const key = await computeCompareMetadataCacheKey({
    registryUrl: ATPM_PROTOCOL,
    packageName: `${identity.did}/${ref.name}`,
    cacheScope: `${PUBLIC_CACHE_SCOPE}-publisher-${ATPM_TRUST_PUBLISHER_RULES_VERSION}-${ATPM_CACHE_ENVELOPE_VERSION}`,
  });
  const cached = await readCompareMetadataCache<AtpmCacheEnvelope<AtpmTrustPublisher | null>>(
    env,
    key,
  );
  if (isFreshEnvelope(cached)) return cached;

  const envelope = cacheEnvelope(await fetchAtpmTrustPublisher(identity, ref.name));
  await writeCompareMetadataCache(env, ctx, key, envelope);
  return envelope;
}

/**
 * Project one version's verified provenance, and the publisher's declaration
 * about it, into the shape the page renders.
 *
 * The two are reported side by side on purpose. The build facts were proven
 * against Sigstore's root and are true regardless of what the record says; the
 * declaration is the publisher's own statement about which pipeline should have
 * produced them. Showing both lets a reader see the agreement — or the absence
 * of one — rather than being handed a single verdict to trust.
 */
export function describeAttestation(
  entry: AtpmVersion,
  publisher: AtpmTrustPublisher | null,
  archiveSha512: string | null,
): PublicDiffAttestation {
  const declared = publisher?.github
    ? {
        declared: {
          repository: trustedPublisherRepositoryUri(publisher.github),
          workflow: `.github/workflows/${publisher.github.workflow}`,
          allowPublish: publisher.allowPublish,
        },
      }
    : {};

  const state = entry.provenance;
  if (state.status === "invalid") {
    return { status: "invalid", reason: state.reason, ...declared };
  }
  if (state.status !== "verified") return { status: state.status, ...declared };

  const { provenance } = state;
  const build = {
    repository: provenance.sourceRepository,
    ref: provenance.sourceRef,
    commit: provenance.sourceCommit,
    workflow: provenance.workflowPath,
    runUrl: provenance.runInvocation,
    runnerEnvironment: provenance.runnerEnvironment,
    signedAt: provenance.signedAt,
    logIndex: provenance.logIndex,
  };
  const expectedSubject = entry.declaredName ? atpmPurl(entry.declaredName, entry.version) : null;
  const mismatches: string[] = [];
  if (!expectedSubject || provenance.subjectName !== expectedSubject) {
    mismatches.push("the attested package does not match this release");
  }
  if (!archiveSha512 || provenance.subjectSha512 !== archiveSha512.toLowerCase()) {
    mismatches.push("the attested digest does not match the downloaded tarball");
  }
  if (mismatches.length) {
    return {
      status: "mismatch",
      reason: mismatches.join("; "),
      build,
      ...declared,
      ...(publisher ? { match: matchTrustedPublisher(provenance, publisher).status } : {}),
    };
  }
  return {
    status: "verified",
    build: {
      ...build,
    },
    ...declared,
    ...(publisher ? { match: matchTrustedPublisher(provenance, publisher).status } : {}),
  };
}

function cacheEnvelope<T>(value: T): AtpmCacheEnvelope<T> {
  return {
    value,
    expiresAt: new Date(Date.now() + ATPM_PAIR_CACHE_TTL_SECONDS * 1000).toISOString(),
  };
}

function isFreshEnvelope<T>(value: AtpmCacheEnvelope<T> | null): value is AtpmCacheEnvelope<T> {
  return Boolean(value && Date.parse(value.expiresAt) > Date.now());
}

function earliestExpiry(first: string, second: string): string {
  return Date.parse(first) <= Date.parse(second) ? first : second;
}

/**
 * The two names a resolved atpm package has.
 *
 * Canonical is always the DID form, whichever way the request spelled it, so
 * that is what `/diff` redirects to and what ends up in a shared URL. This
 * prevents ordinary handle reassignment from silently changing the package a
 * link addresses. `did:web` remains domain-bound, so those pages disclose that
 * their publisher ownership is not permanently pinned.
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
  assertAtpmTarballUrl(entry, url);
  let archive: DownloadResult;
  try {
    archive = await downloadInSandbox(env, ctx, {
      tarballUrl: url,
      archiveFormat: "tgz",
      publicArtifactUrls: [url],
      archiveDigestAlgorithms: ["SHA-1", "SHA-256", "SHA-512"],
    });
  } catch (err) {
    throw publicDiffDownloadError(err);
  }
  assertAtpmBlobDigest(entry.cid, archive.archiveSha256 ?? null);
  assertAtpmArchiveIntegrity(entry.declaredIntegrity, archive.archiveSha512 ?? null);
  return archive;
}
