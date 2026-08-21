import {
  ATPM_IDENTITY_RULES_VERSION,
  resolveAtpmRepoIdentity,
  type AtpmPackageRef,
  type AtpmRepoIdentity,
} from "./identity";
import { ATPM_PROVENANCE_RULES_VERSION } from "./provenance";
import { ATPM_RULES_VERSION, fetchAtpmPackageRecord, type AtpmPackage } from "./record";
import {
  computeCompareMetadataCacheKey,
  readCompareMetadataCache,
  writeCompareMetadataCache,
} from "../../compare-metadata-cache";

export const ATPM_PROTOCOL = "at://";
export const ATPM_PUBLIC_CACHE_SCOPE = "atpm-public";
export const ATPM_PAIR_CACHE_TTL_SECONDS = 5 * 60;
export const ATPM_CACHE_ENVELOPE_VERSION = "absolute-expiry-v1";
export const ATPM_RECORD_CACHE_SCOPE = `${ATPM_PUBLIC_CACHE_SCOPE}-record-${ATPM_RULES_VERSION}-provenance-${ATPM_PROVENANCE_RULES_VERSION}-${ATPM_CACHE_ENVELOPE_VERSION}`;

export interface AtpmCacheEnvelope<T> {
  value: T;
  expiresAt: string;
}

export async function resolveIdentityCached(
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
  if (isFreshAtpmEnvelope(cached)) return cached;

  const identity = await resolveAtpmRepoIdentity(ref);
  const envelope = atpmCacheEnvelope(identity);
  const writes = [writeCompareMetadataCache(env, ctx, key, envelope)];
  // Store the same result under the DID too. Typing a handle into /diff
  // redirects to the DID form, which would otherwise miss this cache and redo
  // the reverse handle lookup that this resolution already performed.
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

export async function fetchRecordCached(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  identity: AtpmRepoIdentity,
  recordName: string,
): Promise<AtpmCacheEnvelope<AtpmPackage>> {
  const key = await computeCompareMetadataCacheKey({
    registryUrl: ATPM_PROTOCOL,
    packageName: `${identity.did}/${recordName}`,
    // Parsing and provenance verification are both part of the trust boundary.
    // A rules bump must not revive a record accepted under older semantics.
    cacheScope: ATPM_RECORD_CACHE_SCOPE,
  });
  const cached = await readCompareMetadataCache<AtpmCacheEnvelope<AtpmPackage>>(env, key);
  if (isFreshAtpmEnvelope(cached)) return cached;

  const envelope = atpmCacheEnvelope(await fetchAtpmPackageRecord(identity, recordName));
  await writeCompareMetadataCache(env, ctx, key, envelope);
  return envelope;
}

function identityCacheKey(authority: string): Promise<string> {
  return computeCompareMetadataCacheKey({
    registryUrl: ATPM_PROTOCOL,
    packageName: authority,
    cacheScope: `${ATPM_PUBLIC_CACHE_SCOPE}-identity-${ATPM_IDENTITY_RULES_VERSION}-${ATPM_CACHE_ENVELOPE_VERSION}`,
  });
}

export function atpmCacheEnvelope<T>(value: T): AtpmCacheEnvelope<T> {
  return {
    value,
    expiresAt: new Date(Date.now() + ATPM_PAIR_CACHE_TTL_SECONDS * 1000).toISOString(),
  };
}

export function isFreshAtpmEnvelope<T>(
  value: AtpmCacheEnvelope<T> | null,
): value is AtpmCacheEnvelope<T> {
  return Boolean(value && Date.parse(value.expiresAt) > Date.now());
}

export function earliestAtpmExpiry(first: string, second: string): string {
  return Date.parse(first) <= Date.parse(second) ? first : second;
}
