import {
  assertPublicHttpsUrl,
  BLOB_CID_RE,
  readBoundedJson,
  reliablePublicHttpsFetch,
  type AtpmRepoIdentity,
} from "./identity";
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
const ATPM_PACKAGE_VERSION_TYPE = `${ATPM_PACKAGE_COLLECTION}#package`;

/**
 * Cache-identity segment for this module's reading and validation of a record.
 * Bump it when the pruned shape, version-selection rules, or atpm-specific
 * metadata checks change, so a cached diff computed under the old rules cannot
 * be served.
 */
export const ATPM_RULES_VERSION = "8";

const RECORD_TIMEOUT_MS = 10_000;

// atproto caps a record at roughly a megabyte. Read generously past that and
// fail rather than truncate: a body this size means the PDS is not serving what
// the protocol says it serves.
const MAX_RECORD_BYTES = 4 * 1024 * 1024;

// atpm versions are npm versions. Keep the record parser and request adapter on
// one predicate so `/versions` never advertises a value the diff route rejects.
const ATPM_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

export function isValidAtpmVersion(version: string): boolean {
  return ATPM_VERSION_RE.test(version);
}

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
  /** Install URL the record exposes through the npm-compatible App View. */
  declaredTarball: string | null;
  /** SRI digest npm clients use to authenticate the installed tarball. */
  declaredIntegrity: string | null;
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
    response = await reliablePublicHttpsFetch(url.toString(), "PDS endpoint", {
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
 * Reduce a raw record value. Individual malformed version entries are dropped,
 * since one unreadable release must not hide every other version of the package.
 * Duplicate syntactically valid version keys invalidate the record, even when
 * one entry is otherwise malformed: an App View may still use that entry's
 * metadata, so pruning it before duplicate detection could make review and
 * installation disagree about which artifact the version names.
 */
export function parseAtpmPackageRecord(value: unknown): AtpmPackage | null {
  if (!isRecord(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.$type !== ATPM_PACKAGE_COLLECTION) return null;
  if (!isAtpmDatetime(record.createdAt)) return null;
  if (!isRecord(record.tags)) return null;
  if (!Array.isArray(record.versions)) return null;

  const versions: AtpmVersion[] = [];
  const seenVersions = new Set<string>();
  for (const entry of record.versions) {
    const rawVersion = isRecord(entry) && typeof entry.version === "string" ? entry.version : null;
    if (rawVersion && isValidAtpmVersion(rawVersion)) {
      if (seenVersions.has(rawVersion)) return null;
      seenVersions.add(rawVersion);
    }
    const parsed = parseVersionEntry(entry);
    if (!parsed) continue;
    versions.push(parsed);
  }

  const tags: Record<string, string> = {};
  for (const [tag, target] of Object.entries(record.tags)) {
    if (typeof target === "string" && target) tags[tag] = target;
  }
  return { tags, versions };
}

function parseVersionEntry(entry: unknown): AtpmVersion | null {
  if (!isRecord(entry)) return null;
  const value = entry as Record<string, unknown>;
  if (value.$type !== undefined && value.$type !== ATPM_PACKAGE_VERSION_TYPE) return null;
  const version = typeof value.version === "string" ? value.version : null;
  if (!version || !isValidAtpmVersion(version)) return null;

  if (!isAtpmDatetime(value.createdAt)) return null;
  if (!isRecord(value.meta)) return null;
  const meta = value.meta;
  if (typeof meta.name !== "string" || !meta.name) return null;
  if (typeof meta.version !== "string" || !meta.version) return null;

  if (!isRecord(value.blob)) return null;
  const blob = value.blob;
  if (blob.$type !== "blob" || !isRecord(blob.ref)) return null;
  const cid = typeof blob.ref.$link === "string" ? blob.ref.$link : null;
  // Without a blob there is nothing to diff — the record would only describe a
  // release, not contain one.
  if (!cid || !BLOB_CID_RE.test(cid)) return null;
  if (!Number.isInteger(blob.size) || (blob.size as number) < 0) return null;
  if (typeof blob.mimeType !== "string" || !blob.mimeType) return null;

  const dist = isRecord(meta.dist) ? meta.dist : {};
  // Absence is allowed for legacy records, but a present digest claim must be
  // readable so malformed metadata cannot collapse into the same state as no claim.
  const declaredShasum = typeof dist.shasum === "string" ? dist.shasum.trim() : null;
  if (dist.shasum !== undefined && (!declaredShasum || !/^[0-9a-f]{40}$/i.test(declaredShasum))) {
    return null;
  }
  if (dist.integrity !== undefined && typeof dist.integrity !== "string") return null;
  return {
    version,
    cid,
    size: blob.size as number,
    mimeType: blob.mimeType,
    createdAt: value.createdAt,
    declaredName: meta.name,
    declaredVersion: meta.version,
    declaredShasum,
    declaredTarball: typeof dist.tarball === "string" ? dist.tarball : null,
    declaredIntegrity: typeof dist.integrity === "string" ? dist.integrity : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAtpmDatetime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
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

/**
 * Bind bytes returned by `getBlob` to the CID named by the package record.
 *
 * atproto blobs use CIDv1 with the raw codec and a SHA-256 multihash. The PDS
 * is still an HTTP server controlled by the party under review, so the request
 * parameter alone is not proof that the response body hashes to that address.
 */
export function assertAtpmBlobDigest(cid: string, archiveSha256: string | null): void {
  const expected = rawSha256FromCid(cid);
  if (!expected || !archiveSha256 || archiveSha256.toLowerCase() !== expected) {
    throw new PublicDiffError("blob bytes do not match their content address", 502);
  }
}

/**
 * Require the install URL exposed by the App View to identify the same blob
 * Drydock reviews. Query ordering and percent-encoding may differ, but the
 * endpoint, DID, and CID must be exact and no extra parameters are accepted.
 */
export function assertAtpmTarballUrl(entry: AtpmVersion, expectedUrl: string): void {
  let declared: URL;
  try {
    declared = new URL(entry.declaredTarball ?? "");
  } catch {
    throw new PublicDiffError("package record has no readable dist.tarball URL", 502);
  }
  const expected = new URL(expectedUrl);
  const parameters = [...declared.searchParams];
  if (
    declared.protocol !== "https:" ||
    declared.username !== "" ||
    declared.password !== "" ||
    declared.origin !== expected.origin ||
    declared.pathname !== expected.pathname ||
    declared.hash !== "" ||
    parameters.length !== 2 ||
    declared.searchParams.getAll("did").length !== 1 ||
    declared.searchParams.get("did") !== expected.searchParams.get("did") ||
    declared.searchParams.getAll("cid").length !== 1 ||
    declared.searchParams.get("cid") !== expected.searchParams.get("cid")
  ) {
    throw new PublicDiffError("dist.tarball does not identify the reviewed blob", 502);
  }
}

/** Require npm's declared SHA-512 SRI, when present, to match the reviewed bytes. */
export function assertAtpmArchiveIntegrity(
  integrity: string | null,
  archiveSha512: string | null,
): void {
  if (integrity === null) return;
  const declaredDigests = integrity
    .trim()
    .split(/\s+/)
    .map(sha512HexFromIntegrityToken)
    .filter((digest): digest is string => digest !== null);
  if (!declaredDigests.length) {
    throw new PublicDiffError("package record has no readable SHA-512 dist.integrity", 502);
  }
  if (!archiveSha512 || !declaredDigests.some((digest) => digest === archiveSha512.toLowerCase())) {
    throw new PublicDiffError("blob bytes do not match dist.integrity", 502);
  }
}

function sha512HexFromIntegrityToken(token: string): string | null {
  const metadata = token.split("?", 1)[0];
  if (!metadata.startsWith("sha512-")) return null;
  try {
    const bytes = Uint8Array.from(atob(metadata.slice("sha512-".length)), (char) =>
      char.charCodeAt(0),
    );
    if (bytes.length !== 64) return null;
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

function rawSha256FromCid(cid: string): string | null {
  const bytes = decodeBase32(cid.slice(1));
  // CIDv1, raw codec, sha2-256 multihash, 32-byte digest.
  if (
    !bytes ||
    bytes.length !== 36 ||
    bytes[0] !== 0x01 ||
    bytes[1] !== 0x55 ||
    bytes[2] !== 0x12 ||
    bytes[3] !== 0x20
  ) {
    return null;
  }
  return [...bytes.subarray(4)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeBase32(value: string): Uint8Array | null {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const output: number[] = [];
  let bits = 0;
  let buffer = 0;
  for (const char of value) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) return null;
    buffer = (buffer << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >>> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  // Canonical base32 has no non-zero padding bits.
  if (buffer !== 0) return null;
  return new Uint8Array(output);
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

  const byVersion = new Map<string, AtpmVersion>();
  for (const entry of pkg.versions) {
    byVersion.set(entry.version, entry);
  }
  const versions = [...byVersion.values()]
    .sort((a, b) => compareSemver(b.version, a.version))
    .map((entry) => ({
      version: entry.version,
      distTags: (tagsByVersion.get(entry.version) ?? []).sort(),
      ...(entry.createdAt ? { publishedAt: entry.createdAt } : {}),
    }));

  // `tags` is an untyped publisher-written object. A stale or malformed latest
  // target must not produce a suggested URL that immediately 404s.
  const taggedLatest = pkg.tags.latest;
  const latest = taggedLatest && byVersion.has(taggedLatest) ? taggedLatest : versions[0]?.version;
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
