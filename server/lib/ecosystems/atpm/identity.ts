import { reliableFetch } from "../../platform/reliable-fetch";
import { PublicDiffError } from "../../public-diff/error";

/**
 * AT Protocol identity resolution for atpm packages.
 *
 * atpm (https://atpm.dev) publishes each package as a record in the publisher's
 * own repository, with the version tarballs attached as blobs. atpm.dev itself
 * is an App View: it maps names to DIDs and re-serves the same data through an
 * npm-compatible API. Drydock deliberately does NOT talk to it. Every step below
 * is a protocol mechanism with its own independent authority — DNS or the
 * publisher's web server for the handle, the PLC directory or the publisher's
 * domain for the DID document, the publisher's PDS for the record and bytes — so
 * a diff stays true even if the App View disappears, disagrees, or is hostile.
 *
 * That is also the security argument for the shape of this module. Every value
 * past the first hop is attacker-influenced: a handle resolves to a DID chosen
 * by whoever controls that domain, a DID document names a PDS chosen by whoever
 * controls the DID. The parent Worker is what fetches all of it, so each URL is
 * rebuilt from validated parts and re-checked against {@link assertPublicHttpsUrl}
 * rather than followed as given.
 */

// Handle -> DID, method 1 (authoritative per the atproto identity spec). Workers
// have no DNS resolver, so the TXT lookup goes over DNS-over-HTTPS. Cloudflare's
// public resolver is the neutral choice from inside a Cloudflare Worker: it is
// infrastructure for the lookup, not a party to the naming.
const DOH_RESOLVER = "https://cloudflare-dns.com/dns-query";

// DID document directory for did:plc. The one centralized component atproto
// itself has; did:web publishers bypass it entirely.
const PLC_DIRECTORY = "https://plc.directory";

const HANDLE_RESOLUTION_TIMEOUT_MS = 5_000;
const DID_DOCUMENT_TIMEOUT_MS = 8_000;

// Identity documents are small. A publisher-controlled endpoint that streams
// megabytes must not be able to occupy the parent Worker, so every read below is
// bounded and the excess is a hard failure rather than a truncated parse.
const MAX_IDENTITY_DOCUMENT_BYTES = 256 * 1024;

/**
 * A handle label, per the atproto handle syntax: ASCII alphanumerics and
 * hyphens, not starting or ending with a hyphen.
 */
const HANDLE_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const DID_PLC_RE = /^did:plc:[a-z2-7]{24}$/;

/** Blob CIDs as atproto renders them in JSON: CIDv1 in canonical base32. */
export const BLOB_CID_RE = /^b[a-z2-7]{20,255}$/;

/**
 * Who a package name says publishes it. A handle is a rented name that must be
 * proven against the DID document; a DID is the identity itself and needs no
 * proof.
 */
type AtpmAuthority = { kind: "handle"; handle: string } | { kind: "did"; did: string };

export interface AtpmPackageRef {
  authority: AtpmAuthority;
  /** The record key in the publisher's repository — the unscoped package name. */
  name: string;
  /** Canonical spelling of the whole name, as the cache and the UI use it. */
  packageName: string;
}

/**
 * atpm package names are npm package names: `@<handle>/<name>`, where the scope
 * is the publisher's atproto handle and the name is the record key in their
 * repository. The DID form `did:plc:.../<name>` is accepted as an equal
 * alternative, because a handle can move between accounts while a DID cannot —
 * it is what atpm.dev's own package pages use, and what a link minted by a tool
 * that already knows the publisher should prefer.
 */
export function parseAtpmPackageName(input: string): AtpmPackageRef | null {
  const raw = input.trim();
  if (!raw || raw.length > 512) return null;
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return null;
  // Exactly one separator: neither a handle nor a DID may contain a slash, so a
  // second one is a different name shape entirely, not a nested path.
  if (raw.indexOf("/", slash + 1) !== -1) return null;

  const scope = raw.slice(0, slash);
  const name = raw.slice(slash + 1);
  if (!isValidRecordName(name)) return null;

  if (scope.startsWith("@")) {
    const handle = normalizeHandle(scope.slice(1));
    if (!handle) return null;
    return { authority: { kind: "handle", handle }, name, packageName: `@${handle}/${name}` };
  }
  if (scope.startsWith("did:")) {
    const did = normalizeDid(scope);
    if (!did) return null;
    return { authority: { kind: "did", did }, name, packageName: `${did}/${name}` };
  }
  return null;
}

export function isValidAtpmPackageName(name: string): boolean {
  return parseAtpmPackageName(name) !== null;
}

/**
 * Canonicalize so the cache key, the cache tag, and the payload identity agree.
 * Only the authority is lowercased: handles are case-insensitive and DIDs are
 * lowercase by construction for both methods atproto allows, but a record key is
 * case-sensitive, so folding the name would let two distinct records share one
 * cache entry.
 */
export function normalizeAtpmPackageName(name: string): string {
  return parseAtpmPackageName(name)?.packageName ?? name.trim();
}

/**
 * Record keys are `[a-zA-Z0-9._~:-]{1,512}` in atproto and lowercase npm names
 * in practice. The intersection is what atpm can actually address, and keeping
 * it narrow means the value is safe to interpolate anywhere a package name goes.
 */
function isValidRecordName(name: string): boolean {
  if (name.length > 128) return false;
  if (name === "." || name === "..") return false;
  if (name.startsWith(".") || name.startsWith("_")) return false;
  return /^[a-z0-9][a-z0-9._-]*$/.test(name);
}

function normalizeHandle(input: string): string | null {
  const handle = input.toLowerCase();
  if (handle.length < 3 || handle.length > 253) return null;
  // A handle IS a domain name, and both resolution methods need it to be one we
  // are willing to talk to — the well-known method fetches the handle's own
  // host. Reusing the host policy keeps "@alice.test/pkg is not an addressable
  // name" a clean 400 instead of a confusing failure three hops later.
  return isPublicHostname(handle) ? handle : null;
}

/**
 * atproto allows exactly two DID methods, and no others are resolvable here:
 * `did:plc` (resolved through the PLC directory) and `did:web` (resolved through
 * the domain's own web server). Anything else has no resolution path at all, so
 * accepting it would only produce a confusing downstream failure.
 */
function normalizeDid(input: string): string | null {
  const did = input.trim();
  if (did.length > 2048) return null;
  if (DID_PLC_RE.test(did.toLowerCase())) return did.toLowerCase();
  if (did.toLowerCase().startsWith("did:web:")) {
    // atproto forbids ports and paths in did:web, which conveniently also
    // forbids the percent-encoded colon that would smuggle one in.
    const host = did.slice("did:web:".length).toLowerCase();
    return isPublicHostname(host) && host.includes(".") ? `did:web:${host}` : null;
  }
  return null;
}

/**
 * Hostname policy for every publisher-controlled host the parent Worker fetches.
 *
 * A DID document names its own PDS, so "which host do we call" is data supplied
 * by the party under review. This blocks the shapes that turn that into a probe
 * of something that is not on the public internet: literal addresses (which skip
 * public DNS entirely), loopback and internal suffixes, and single-label names
 * that resolve through a private search domain.
 */
function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!host || host.length > 253) return false;
  if (host.startsWith("[") || host.endsWith("]")) return false;
  // IPv4 literal, or anything that is all digits and dots.
  if (/^[0-9.]+$/.test(host)) return false;
  // IPv6 literal without brackets.
  if (host.includes(":")) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => HANDLE_LABEL_RE.test(label))) return false;
  const tld = labels[labels.length - 1];
  if (!/^[a-z]/.test(tld)) return false;
  return !RESERVED_TLDS.has(tld);
}

// Suffixes that resolve inside a network rather than on the public internet.
const RESERVED_TLDS = new Set([
  "local",
  "localhost",
  "internal",
  "intranet",
  "home",
  "lan",
  "test",
]);

/**
 * Re-validate a URL built from resolved data before the parent Worker fetches
 * it. Rejecting a non-default port is part of the policy, not an oversight: a
 * DID document that names `https://<public-host>:9200` would otherwise turn this
 * resolver into a port prober, and atproto PDS endpoints are served on 443.
 */
export function assertPublicHttpsUrl(value: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicDiffError(`${what} is not a valid URL`, 502);
  }
  if (url.protocol !== "https:") throw new PublicDiffError(`${what} must be https`, 502);
  if (url.username || url.password) {
    throw new PublicDiffError(`${what} must not carry credentials`, 502);
  }
  if (url.port && url.port !== "443") {
    throw new PublicDiffError(`${what} must use the default https port`, 502);
  }
  if (!isPublicHostname(url.hostname)) {
    throw new PublicDiffError(`${what} does not name a public host`, 502);
  }
  return url;
}

/** A publisher's identity, resolved far enough to fetch their records. */
export interface AtpmRepoIdentity {
  did: string;
  /** Origin of the publisher's PDS, e.g. `https://shiitake.us-east.host.bsky.network`. */
  pds: string;
  /**
   * The handle, only ever set when this resolution proved it in both directions:
   * the handle resolves to this DID, and the DID document claims that handle
   * back. Null when the account has no verifiable handle, in which case the DID
   * is the only name for it.
   */
  handle: string | null;
  /** Which mechanism produced the DID, for the resolution trail shown on /diff. */
  handleMethod: HandleMethod | null;
}

type HandleMethod = "dns" | "well-known";

export async function resolveAtpmRepoIdentity(ref: AtpmPackageRef): Promise<AtpmRepoIdentity> {
  const resolved =
    ref.authority.kind === "handle"
      ? await resolveHandle(ref.authority.handle)
      : { did: ref.authority.did, method: null };

  const document = await fetchDidDocument(resolved.did);
  const pds = pdsEndpoint(document);
  if (!pds) throw new PublicDiffError("DID document declares no atproto PDS", 502);

  const verified =
    ref.authority.kind === "handle"
      ? verifyRequestedHandle(document, ref.authority.handle, resolved.method)
      : // A DID-addressed lookup has no handle to check, so the document's own
        // claim is checked instead — see verifyClaimedHandle for why that costs
        // an extra lookup rather than being taken at face value.
        await verifyClaimedHandle(document, resolved.did);

  return {
    did: resolved.did,
    pds: assertPublicHttpsUrl(pds, "PDS endpoint").origin,
    handle: verified?.handle ?? null,
    handleMethod: verified?.method ?? null,
  };
}

/**
 * Bidirectional verification, required by the atproto identity spec: a handle is
 * only that account's handle if the account claims it back. Without this a domain
 * could point `_atproto` at anyone's DID and serve their packages under its own
 * name, so a document that does not claim the handle back fails the request
 * rather than quietly downgrading to the DID.
 */
function verifyRequestedHandle(
  document: DidDocument,
  handle: string,
  method: HandleMethod | null,
): { handle: string; method: HandleMethod | null } {
  if (!claimsHandle(document, handle)) {
    throw new PublicDiffError(
      "handle does not verify: the DID document does not claim it back",
      502,
    );
  }
  return { handle, method };
}

/**
 * Resolve the handle a DID document claims, and prove it independently.
 *
 * `alsoKnownAs` is written by the DID's controller, so on its own it is an
 * assertion, not a fact — a repository could claim any handle it liked. This
 * resolves the claimed handle back through DNS/well-known and keeps it only if
 * it points at this same DID, which is the same bidirectional standard a
 * handle-addressed lookup is held to.
 *
 * The payoff is that a DID-addressed URL — the permalink form `/diff` redirects
 * to — can still be presented as `@handle/name` rather than as a raw DID.
 *
 * Only the document's first well-formed handle claim is checked. It is the
 * primary handle by convention, and resolving every entry would let a document
 * with a long `alsoKnownAs` list turn one page view into many lookups. A failure
 * here is not an error: the caller falls back to the DID.
 */
async function verifyClaimedHandle(
  document: DidDocument,
  did: string,
): Promise<{ handle: string; method: HandleMethod } | null> {
  const claimed = claimedHandles(document)[0];
  if (!claimed) return null;
  const resolved = await tryResolveHandle(claimed);
  if (!resolved || resolved.did !== did) return null;
  return { handle: claimed, method: resolved.method };
}

async function resolveHandle(handle: string): Promise<{ did: string; method: HandleMethod }> {
  const resolved = await tryResolveHandle(handle);
  if (resolved) return resolved;
  throw new PublicDiffError(`handle ${handle} does not resolve to an atproto DID`, 404);
}

async function tryResolveHandle(
  handle: string,
): Promise<{ did: string; method: HandleMethod } | null> {
  const fromDns = await resolveHandleViaDns(handle);
  if (fromDns) return { did: fromDns, method: "dns" };
  const fromWellKnown = await resolveHandleViaWellKnown(handle);
  if (fromWellKnown) return { did: fromWellKnown, method: "well-known" };
  return null;
}

interface DohAnswer {
  Answer?: Array<{ type?: number; data?: unknown }>;
}

// TXT record type; other answer types in the same response (CNAME chains) are
// not handle claims and must be ignored rather than parsed.
const DNS_TYPE_TXT = 16;

async function resolveHandleViaDns(handle: string): Promise<string | null> {
  const url = new URL(DOH_RESOLVER);
  url.searchParams.set("name", `_atproto.${handle}`);
  url.searchParams.set("type", "TXT");

  let payload: DohAnswer;
  try {
    const response = await reliableFetch(url.toString(), {
      headers: new Headers({ accept: "application/dns-json" }),
      timeoutMs: HANDLE_RESOLUTION_TIMEOUT_MS,
    });
    if (!response.ok) return null;
    payload = (await readBoundedJson<DohAnswer>(response)) ?? {};
  } catch {
    // A DNS failure is not a resolution failure — the well-known method is an
    // equally valid way to prove the same handle.
    return null;
  }

  const dids: string[] = [];
  for (const answer of payload.Answer ?? []) {
    if (answer.type !== DNS_TYPE_TXT || typeof answer.data !== "string") continue;
    // DoH renders TXT strings quoted, and a long record arrives as several
    // concatenated quoted chunks.
    const text = answer.data.replace(/"\s+"/g, "").replace(/^"|"$/g, "");
    if (!text.startsWith("did=")) continue;
    const did = normalizeDid(text.slice("did=".length).trim());
    if (did) dids.push(did);
  }
  // More than one claim is ambiguous, and picking either would be a guess about
  // which account owns the handle. The spec calls this invalid; so do we.
  return dids.length === 1 ? dids[0] : null;
}

async function resolveHandleViaWellKnown(handle: string): Promise<string | null> {
  try {
    // `normalizeHandle` already applied this policy, so the assert is here to
    // keep one enforcement point rather than to catch a reachable case. It sits
    // inside the try so that if the two ever disagree, this method reports "no
    // claim" and the caller still 404s the handle — not a 502 from a fallback.
    const url = assertPublicHttpsUrl(`https://${handle}/.well-known/atproto-did`, "handle host");
    const response = await reliableFetch(url.toString(), {
      headers: new Headers({ accept: "text/plain" }),
      timeoutMs: HANDLE_RESOLUTION_TIMEOUT_MS,
    });
    if (!response.ok) return null;
    const body = await readBoundedText(response, 2048);
    return body === null ? null : normalizeDid(body.trim());
  } catch {
    return null;
  }
}

interface DidDocument {
  id?: unknown;
  alsoKnownAs?: unknown;
  service?: unknown;
}

async function fetchDidDocument(did: string): Promise<DidDocument> {
  const url = did.startsWith("did:plc:")
    ? `${PLC_DIRECTORY}/${encodeURIComponent(did)}`
    : `https://${did.slice("did:web:".length)}/.well-known/did.json`;
  assertPublicHttpsUrl(url, "DID document host");

  let response: Response;
  try {
    response = await reliableFetch(url, {
      headers: new Headers({ accept: "application/json" }),
      timeoutMs: DID_DOCUMENT_TIMEOUT_MS,
    });
  } catch {
    throw new PublicDiffError("DID document fetch failed", 502);
  }
  if (response.status === 404 || response.status === 410) {
    throw new PublicDiffError("DID does not exist", 404);
  }
  if (!response.ok) throw new PublicDiffError("DID document fetch failed", 502);

  const document = await readBoundedJson<DidDocument>(response);
  if (!document || typeof document !== "object") {
    throw new PublicDiffError("DID document is not valid JSON", 502);
  }
  // A document that describes a different subject proves nothing about this DID;
  // did:web in particular is just a file on a web server.
  if (document.id !== did) throw new PublicDiffError("DID document is for a different DID", 502);
  return document;
}

function claimsHandle(document: DidDocument, handle: string): boolean {
  return claimedHandles(document).includes(handle);
}

/**
 * The `at://` handles a DID document claims, in document order, normalized and
 * filtered to ones that could actually be resolved. These are claims, not facts;
 * every caller either checks them against a handle it was given or proves them
 * with a reverse lookup.
 */
function claimedHandles(document: DidDocument): string[] {
  const aka = Array.isArray(document.alsoKnownAs) ? document.alsoKnownAs : [];
  const handles: string[] = [];
  for (const entry of aka) {
    if (typeof entry !== "string") continue;
    const lower = entry.toLowerCase();
    if (!lower.startsWith("at://")) continue;
    const handle = normalizeHandle(lower.slice("at://".length));
    if (handle && !handles.includes(handle)) handles.push(handle);
  }
  return handles;
}

function pdsEndpoint(document: DidDocument): string | null {
  const services = Array.isArray(document.service) ? document.service : [];
  for (const service of services) {
    if (!service || typeof service !== "object") continue;
    const entry = service as { id?: unknown; type?: unknown; serviceEndpoint?: unknown };
    // The fragment identifies the service; a document may carry several, and
    // only `#atproto_pds` holds the repository.
    const id = typeof entry.id === "string" ? entry.id : "";
    if (!id.endsWith("#atproto_pds")) continue;
    if (entry.type !== "AtprotoPersonalDataServer") continue;
    if (typeof entry.serviceEndpoint === "string") return entry.serviceEndpoint;
  }
  return null;
}

/**
 * Read a response body under a hard byte ceiling. `response.json()` would let a
 * publisher-controlled endpoint decide how much memory the parent Worker spends
 * on what is supposed to be a few kilobytes of identity metadata.
 */
async function readBoundedText(
  response: Response,
  maxBytes = MAX_IDENTITY_DOCUMENT_BYTES,
): Promise<string | null> {
  const declared = Number(response.headers.get("content-length") || "0");
  if (declared > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export async function readBoundedJson<T>(
  response: Response,
  maxBytes = MAX_IDENTITY_DOCUMENT_BYTES,
): Promise<T | null> {
  const text = await readBoundedText(response, maxBytes);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
