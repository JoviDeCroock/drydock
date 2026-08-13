import {
  assertPublicHttpsUrl,
  BLOB_CID_RE,
  readBoundedJson,
  type AtpmRepoIdentity,
} from "./identity";
import { reliableFetch } from "../../platform/reliable-fetch";
import { PublicDiffError } from "../../public-diff/error";
import { compareSemver } from "../npm/registry";

/**
 * The `dev.atpm.alpha.package` record: one record per package, keyed by the
 * unscoped package name, holding every version inline.
 *
 * This is the whole registry for that package. There is no separate packument
 * and no version endpoint — `tags` is the dist-tag map, `versions[]` is the
 * version list, each entry's `blob` is the tarball, and each entry's `meta` is
 * the npm manifest an installing client is handed. Two of those come from
 * different places and can disagree, which is the point of
 * `atpmRecordFindings`: `meta` is whatever the publisher wrote into the record,
 * while the blob is the artifact that actually installs.
 */
export const ATPM_PACKAGE_COLLECTION = "dev.atpm.alpha.package";

/**
 * Cache-identity segment for this module's own reading of a record. Bump it when
 * the pruned shape or the version-selection rules change, so a cached diff
 * computed under the old reading cannot be served.
 */
export const ATPM_RULES_VERSION = "1";

const RECORD_TIMEOUT_MS = 10_000;

// atproto caps a record at roughly a megabyte. Read generously past that and
// fail rather than truncate: a body this size means the PDS is not serving what
// the protocol says it serves.
const MAX_RECORD_BYTES = 4 * 1024 * 1024;

/** One version, reduced to the fields a diff and its integrity checks need. */
export interface AtpmVersion {
  version: string;
  /** Blob CID of the tarball, the content address the bytes are fetched by. */
  cid: string;
  size: number | null;
  mimeType: string | null;
  createdAt: string | null;
  /** Name the record's own npm manifest claims for this version. */
  declaredName: string | null;
  /** Version the record's own npm manifest claims. */
  declaredVersion: string | null;
  /** SHA-1 the record claims for the tarball (npm's `dist.shasum`). */
  declaredShasum: string | null;
}

export interface AtpmPackage {
  /** Dist-tag map, e.g. `{ latest: "0.0.15" }`. */
  tags: Record<string, string>;
  versions: AtpmVersion[];
}

/**
 * Fetch and reduce a package record from the publisher's own PDS.
 *
 * The reduction is not just tidiness. A record carries the full npm manifest per
 * version — readme text and base64 Sigstore bundles included — which for a
 * modest package is already tens of kilobytes and grows with every release. Only
 * the fields below are ever read, so everything else is dropped before the value
 * is returned or cached.
 */
export async function fetchAtpmPackageRecord(
  identity: AtpmRepoIdentity,
  name: string,
): Promise<AtpmPackage> {
  const url = new URL("/xrpc/com.atproto.repo.getRecord", identity.pds);
  url.searchParams.set("repo", identity.did);
  url.searchParams.set("collection", ATPM_PACKAGE_COLLECTION);
  url.searchParams.set("rkey", name);
  assertPublicHttpsUrl(url.toString(), "PDS endpoint");

  let response: Response;
  try {
    response = await reliableFetch(url.toString(), {
      headers: new Headers({ accept: "application/json" }),
      timeoutMs: RECORD_TIMEOUT_MS,
    });
  } catch {
    throw new PublicDiffError("package record fetch failed", 502);
  }

  const body = await readBoundedJson<{ value?: unknown; error?: unknown }>(
    response,
    MAX_RECORD_BYTES,
  );
  // A PDS answers "no such record" with 400 RecordNotFound, not 404, so the
  // status alone cannot distinguish a missing package from a broken request.
  if (body?.error === "RecordNotFound" || response.status === 404) {
    throw new PublicDiffError("package not found", 404);
  }
  if (!response.ok || !body) throw new PublicDiffError("package record fetch failed", 502);

  const parsed = parseAtpmPackageRecord(body.value);
  if (!parsed) throw new PublicDiffError("package record is not a readable atpm package", 502);
  return parsed;
}

/**
 * Reduce a raw record value. Returns null only when the value is not an atpm
 * package record at all; individual malformed version entries are dropped, since
 * one unreadable release must not hide every other version of the package.
 */
export function parseAtpmPackageRecord(value: unknown): AtpmPackage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.$type !== undefined && record.$type !== ATPM_PACKAGE_COLLECTION) return null;
  if (!Array.isArray(record.versions)) return null;

  const versions: AtpmVersion[] = [];
  for (const entry of record.versions) {
    const parsed = parseVersionEntry(entry);
    if (parsed) versions.push(parsed);
  }

  const tags: Record<string, string> = {};
  const rawTags = record.tags;
  if (rawTags && typeof rawTags === "object" && !Array.isArray(rawTags)) {
    for (const [tag, target] of Object.entries(rawTags as Record<string, unknown>)) {
      if (typeof target === "string" && target) tags[tag] = target;
    }
  }
  return { tags, versions };
}

function parseVersionEntry(entry: unknown): AtpmVersion | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const value = entry as Record<string, unknown>;
  const version = typeof value.version === "string" ? value.version : null;
  if (!version) return null;

  const blob = value.blob as { ref?: { $link?: unknown }; size?: unknown; mimeType?: unknown };
  const cid = typeof blob?.ref?.$link === "string" ? blob.ref.$link : null;
  // Without a blob there is nothing to diff — the record would only describe a
  // release, not contain one.
  if (!cid || !BLOB_CID_RE.test(cid)) return null;

  const meta = (value.meta ?? {}) as Record<string, unknown>;
  const dist = (meta.dist ?? {}) as Record<string, unknown>;
  return {
    version,
    cid,
    size: typeof blob.size === "number" && blob.size >= 0 ? blob.size : null,
    mimeType: typeof blob.mimeType === "string" ? blob.mimeType : null,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
    declaredName: typeof meta.name === "string" ? meta.name : null,
    declaredVersion: typeof meta.version === "string" ? meta.version : null,
    declaredShasum: typeof dist.shasum === "string" ? dist.shasum : null,
  };
}

/**
 * The URL the tarball bytes are fetched from — built here from the resolved PDS
 * and the blob's content address, never taken from the record.
 *
 * `meta.dist.tarball` in the record points at this same endpoint today, but it
 * is a publisher-written string in publisher-written data: following it would
 * let a record name any host on the internet as the source of the bytes Drydock
 * then presents as that package's release. The CID is the content address, so
 * rebuilding the URL costs nothing and removes the choice from the record.
 */
export function atpmBlobUrl(identity: AtpmRepoIdentity, cid: string): string {
  if (!BLOB_CID_RE.test(cid)) throw new PublicDiffError("invalid blob CID", 502);
  const url = new URL("/xrpc/com.atproto.sync.getBlob", identity.pds);
  url.searchParams.set("did", identity.did);
  url.searchParams.set("cid", cid);
  return assertPublicHttpsUrl(url.toString(), "blob endpoint").toString();
}

export interface AtpmVersionListEntry {
  version: string;
  distTags: string[];
  publishedAt?: string;
}

/**
 * Version listing, newest-first by semver.
 *
 * Order comes from the version numbers rather than the record's array order:
 * `versions[]` is publisher-written and a backport released after a major bump
 * would otherwise land at the top of the picker. The suggested pair is the
 * `latest` dist-tag against its immediate semver predecessor, matching npm.
 */
export function listAtpmVersions(pkg: AtpmPackage): {
  versions: AtpmVersionListEntry[];
  suggested: { from: string; to: string } | null;
} {
  const tagsByVersion = new Map<string, string[]>();
  for (const [tag, target] of Object.entries(pkg.tags)) {
    const list = tagsByVersion.get(target) ?? [];
    list.push(tag);
    tagsByVersion.set(target, list);
  }

  // A record may list the same version more than once; the picker must show it
  // once, and `requireAtpmVersion` resolves it to the first entry either way.
  const byVersion = new Map<string, AtpmVersion>();
  for (const entry of pkg.versions) {
    if (!byVersion.has(entry.version)) byVersion.set(entry.version, entry);
  }
  const versions = [...byVersion.values()]
    .sort((a, b) => compareSemver(b.version, a.version))
    .map((entry) => ({
      version: entry.version,
      distTags: (tagsByVersion.get(entry.version) ?? []).sort(),
      ...(entry.createdAt ? { publishedAt: entry.createdAt } : {}),
    }));

  const latest = pkg.tags.latest ?? versions[0]?.version ?? null;
  const previous = latest
    ? (versions.find(
        (entry) => entry.version !== latest && compareSemver(entry.version, latest) < 0,
      )?.version ?? null)
    : null;
  return { versions, suggested: latest && previous ? { from: previous, to: latest } : null };
}

/** Look up one version's entry, or 404 the way a registry would. */
export function requireAtpmVersion(pkg: AtpmPackage, version: string): AtpmVersion {
  const entry = pkg.versions.find((candidate) => candidate.version === version);
  if (!entry) throw new PublicDiffError("unknown version", 404);
  return entry;
}
