import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  assertPublicHttpsUrl,
  BLOB_CID_RE,
  readBoundedJson,
  reliablePublicHttpsFetch,
  type AtpmRepoIdentity,
} from "./identity";
import {
  ATPM_PROVENANCE_ABSENT,
  ATPM_PROVENANCE_NOT_EVALUATED,
  readAtpmAttestation,
  verifyAtpmProvenance,
  type AtpmProvenanceState,
} from "./provenance";
import { isValidAtpmVersion } from "./record";
import { PublicDiffError } from "../../public-diff/error";

/**
 * The `dev.atpm.alpha.stage` record: a release candidate that has been uploaded
 * but not published.
 *
 * atpm splits publishing in two. `npm stage publish` writes one of these
 * records and uploads the tarball as a blob; approving it later moves the
 * release into the `dev.atpm.alpha.package` record that installs resolve
 * against, and deletes this one.
 *
 * The consequence for review is the useful one: a staged candidate is an
 * ordinary public record in the publisher's repository and its bytes are a
 * CID-addressed blob, so reading one needs no credential and no cooperation
 * from anybody. That is what lets `/diff` show a release before it exists.
 * Drydock only reads — approving or withdrawing a candidate is done in atpm.
 */
const ATPM_STAGE_COLLECTION = "dev.atpm.alpha.stage";

const STAGE_TIMEOUT_MS = 10_000;

// One staged record holds a full npm manifest and possibly a Sigstore bundle.
const MAX_STAGE_RECORD_BYTES = 4 * 1024 * 1024;

/** atproto record keys for staged entries are TIDs, written by the CLI. */
const TID_RE = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;

export function isValidAtpmStageRkey(rkey: string): boolean {
  return TID_RE.test(rkey);
}

/** One staged release candidate, reduced to the fields review reads. */
export interface AtpmStagedVersion {
  /** Record key in the publisher's repository — a TID. */
  rkey: string;
  /** `at://<did>/dev.atpm.alpha.stage/<rkey>`. */
  uri: string;
  /** Content address of the record itself, which atpm's stage id folds in. */
  recordCid: string;
  /** Scoped package name the candidate claims, e.g. `@ebey.dev/counter`. */
  declaredName: string;
  version: string;
  /** Name the candidate's embedded npm manifest claims, which must agree. */
  declaredManifestName: string;
  /** Version the candidate's embedded npm manifest claims, which must agree. */
  declaredVersion: string;
  /** Dist-tag the candidate would take on approval. */
  tag: string | null;
  createdAt: string;
  /** Blob CID of the candidate tarball. */
  cid: string;
  size: number | null;
  declaredShasum: string | null;
  declaredIntegrity: string | null;
  declaredTarball: string | null;
  provenance: AtpmProvenanceState;
}

interface RawStageRecord {
  uri?: unknown;
  cid?: unknown;
  value?: unknown;
}

/** Fetch one staged candidate by record key, or 404 the way a registry would. */
export async function fetchAtpmStagedVersion(
  identity: AtpmRepoIdentity,
  rkey: string,
): Promise<AtpmStagedVersion> {
  if (!isValidAtpmStageRkey(rkey)) throw new PublicDiffError("invalid staged record key", 400);

  const url = new URL("/xrpc/com.atproto.repo.getRecord", identity.pds);
  url.searchParams.set("repo", identity.did);
  url.searchParams.set("collection", ATPM_STAGE_COLLECTION);
  url.searchParams.set("rkey", rkey);
  assertPublicHttpsUrl(url.toString(), "PDS endpoint");

  let response: Response;
  try {
    response = await reliablePublicHttpsFetch(url.toString(), "PDS endpoint", {
      headers: new Headers({ accept: "application/json" }),
      timeoutMs: STAGE_TIMEOUT_MS,
    });
  } catch {
    throw new PublicDiffError("staged record fetch failed", 502);
  }

  const body = await readBoundedJson<RawStageRecord & { error?: unknown }>(
    response,
    MAX_STAGE_RECORD_BYTES,
  );
  if (body?.error === "RecordNotFound" || response.status === 404) {
    // An approved or rejected candidate has had its record deleted, which is
    // indistinguishable from one that never existed and reads the same way.
    throw new PublicDiffError("staged release not found", 404);
  }
  if (!response.ok || !body) throw new PublicDiffError("staged record fetch failed", 502);

  const parsed = await parseStageRecord(identity, body);
  if (!parsed) throw new PublicDiffError("staged record is not a readable atpm candidate", 502);
  if (parsed.rkey !== rkey) {
    throw new PublicDiffError("staged record response did not match the requested key", 502);
  }
  return parsed;
}

/**
 * Reduce one `listRecords`/`getRecord` entry.
 *
 * Validation mirrors `./record.ts` deliberately: a staged candidate becomes a
 * published version unchanged, so anything this accepts here is something the
 * published path must also be able to read. Returns null for a record that does
 * not describe a reviewable candidate.
 */
async function parseStageRecord(
  identity: AtpmRepoIdentity,
  record: RawStageRecord,
  verifyProvenance = true,
): Promise<AtpmStagedVersion | null> {
  const uri = typeof record.uri === "string" ? record.uri : null;
  const recordCid = typeof record.cid === "string" ? record.cid : null;
  if (!uri || !recordCid) return null;

  const prefix = `at://${identity.did}/${ATPM_STAGE_COLLECTION}/`;
  // The URI is echoed by the PDS. Requiring it to name the repository and
  // collection we asked for stops a listing from smuggling in an entry
  // attributed to a different DID.
  if (!uri.startsWith(prefix)) return null;
  const rkey = uri.slice(prefix.length);
  if (!isValidAtpmStageRkey(rkey)) return null;

  const value = asObject(record.value);
  if (!value) return null;
  await assertAtpmRecordCid(value, recordCid);
  if (value.$type !== undefined && value.$type !== ATPM_STAGE_COLLECTION) return null;
  if (!isDatetime(value.createdAt)) return null;

  const declaredName = typeof value.name === "string" ? value.name : null;
  const version = typeof value.version === "string" ? value.version : null;
  if (!declaredName || !version || !isValidAtpmVersion(version)) return null;
  const tag = candidateTag(value.tags, version);
  if (!tag) return null;

  const blob = asObject(value.blob);
  const ref = asObject(blob?.ref);
  const cid = typeof ref?.$link === "string" ? ref.$link : null;
  if (blob?.$type !== "blob" || !cid || !BLOB_CID_RE.test(cid)) return null;
  if (!Number.isInteger(blob.size) || (blob.size as number) < 0) return null;
  if (typeof blob.mimeType !== "string" || !blob.mimeType) return null;

  const meta = asObject(value.meta);
  if (!meta) return null;
  const declaredManifestName = typeof meta.name === "string" ? meta.name : null;
  const declaredVersion = typeof meta.version === "string" ? meta.version : null;
  if (!declaredManifestName || !declaredVersion) return null;
  const dist = asObject(meta.dist);
  const declaredShasum = typeof dist?.shasum === "string" ? dist.shasum.trim() : null;
  if (dist?.shasum !== undefined && (!declaredShasum || !/^[0-9a-f]{40}$/i.test(declaredShasum))) {
    return null;
  }
  if (dist?.integrity !== undefined && typeof dist.integrity !== "string") return null;

  return {
    rkey,
    uri,
    recordCid,
    declaredName,
    version,
    declaredManifestName,
    declaredVersion,
    tag,
    createdAt: value.createdAt,
    cid,
    size: blob.size as number,
    declaredShasum,
    declaredIntegrity: typeof dist?.integrity === "string" ? dist.integrity : null,
    declaredTarball: typeof dist?.tarball === "string" ? dist.tarball : null,
    provenance: verifyProvenance
      ? await verifyAtpmProvenance(readAtpmAttestation(meta))
      : readAtpmAttestation(meta) === null
        ? ATPM_PROVENANCE_ABSENT
        : ATPM_PROVENANCE_NOT_EVALUATED,
  };
}

/**
 * Authenticate the staged value against the CID the PDS returned for it.
 *
 * `getRecord` is served by the publisher's PDS, so its `cid` field is only a
 * claim until the record value is encoded and hashed locally. The staged review
 * URL uses this CID as its immutable revision pin and cache identity; accepting
 * an echoed-but-unverified string would let one URL describe different values.
 */
export async function assertAtpmRecordCid(value: unknown, recordCid: string): Promise<void> {
  let declared: CID;
  try {
    declared = CID.parse(recordCid);
  } catch {
    throw new PublicDiffError("staged record has an invalid content address", 502);
  }
  if (
    declared.version !== 1 ||
    declared.code !== dagCbor.code ||
    declared.multihash.code !== sha256.code ||
    declared.multihash.digest.length !== 32
  ) {
    throw new PublicDiffError("staged record has an invalid content address", 502);
  }

  let computed: CID;
  try {
    const bytes = dagCbor.encode(atprotoJsonToIpld(value));
    computed = CID.createV1(dagCbor.code, await sha256.digest(bytes));
  } catch {
    throw new PublicDiffError("staged record cannot be content-addressed", 502);
  }
  if (!computed.equals(declared)) {
    throw new PublicDiffError("staged record content address does not match its value", 502);
  }
}

/** Compute the canonical record CID for trusted fixtures and protocol tooling. */
export async function atpmRecordCid(value: unknown): Promise<string> {
  const bytes = dagCbor.encode(atprotoJsonToIpld(value));
  return CID.createV1(dagCbor.code, await sha256.digest(bytes)).toString();
}

type IpldValue =
  | null
  | boolean
  | string
  | number
  | Uint8Array
  | CID
  | IpldValue[]
  | { [key: string]: IpldValue };

/** Convert AT Protocol's JSON wrappers back to the IPLD values DAG-CBOR hashes. */
function atprotoJsonToIpld(value: unknown): IpldValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("AT Protocol records contain integers only");
    return value;
  }
  if (Array.isArray(value)) return value.map(atprotoJsonToIpld);
  if (!value || typeof value !== "object") throw new Error("unsupported AT Protocol value");

  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length === 1 && typeof object.$link === "string") return CID.parse(object.$link);
  if (keys.length === 1 && typeof object.$bytes === "string") {
    return decodeAtprotoBytes(object.$bytes);
  }

  // Record keys are hostile too. In particular, assigning `__proto__` to a
  // normal object invokes its legacy setter instead of creating the own
  // property that DAG-CBOR must hash.
  const converted = Object.create(null) as Record<string, IpldValue>;
  for (const [key, entry] of Object.entries(object)) converted[key] = atprotoJsonToIpld(entry);
  return converted;
}

function decodeAtprotoBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("invalid AT Protocol bytes");
  }
  const decoded = atob(value);
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

/**
 * The dist-tag a candidate would take on approval. atpm merges this entire
 * publisher-written object into the package record, so review only accepts the
 * CLI shape it can model honestly: exactly one tag targeting this candidate.
 */
function candidateTag(tags: unknown, candidateVersion: string): string | null {
  const record = asObject(tags);
  if (!record) return null;
  const entries = Object.entries(record);
  if (entries.length !== 1) return null;
  const [tag, target] = entries[0];
  return tag && target === candidateVersion ? tag : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isDatetime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
