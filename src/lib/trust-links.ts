/**
 * Off-site links for the /diff trust card. Every value here is
 * publisher-controlled (an unsigned resolution trail, or strings parsed out of
 * a Fulcio certificate), so each href is rebuilt from validated parts and a
 * value can never choose its own scheme or host. Kept apart from the component
 * so the safety property is testable without rendering.
 */
import type { PublicDiffAttestation, PublicDiffResponse } from "../models/package-diff";

// Destinations for the resolution trail, keyed by the step label the server
// emits.
//
// Unlike the attestation, none of this is signed — a publisher picks their own
// handle, their own PDS, and the contents of their own repository. Linking it
// is still right, and safe, because of how the hrefs are built: the host is
// either fixed (`plc.directory`, `dns.google`) or a hostname the value itself
// has to parse as, and every path and query part is validated by shape and
// re-encoded. No value reaches an `href` as the string it arrived as, so a
// record cannot smuggle a scheme or a destination of its choosing into this
// column. What a publisher does control is which of *their* servers a reader is
// sent to, which is exactly what the row is claiming and what the reader came
// to check.
export function resolutionLinks(
  steps: PublicDiffResponse["provenance"],
): Map<string, string | null> {
  const byLabel = new Map(steps.map((step) => [step.label, step]));
  const links = new Map<string, string | null>();

  const handle = byLabel.get("Handle");
  if (handle) {
    const host = hostnameOrNull(handle.value.replace(/^@/, ""));
    // The proof for a handle is whichever record the resolver read: a TXT
    // record under `_atproto`, or a file on the handle's own domain.
    links.set(
      "Handle",
      !host
        ? null
        : handle.detail === "DNS TXT"
          ? `https://dns.google/resolve?name=${encodeURIComponent(`_atproto.${host}`)}&type=TXT`
          : `https://${host}/.well-known/atproto-did`,
    );
  }

  const did = byLabel.get("DID");
  if (did) links.set("DID", didDocumentUrl(did.value));

  const pds = byLabel.get("PDS");
  const pdsHost = pds ? hostnameOrNull(pds.value) : null;
  // describeServer rather than the bare origin: a PDS root is whatever the
  // operator serves there, while this endpoint answers the question the row
  // raises — which server is this, and what does it say it is.
  if (pds) {
    links.set("PDS", pdsHost ? `https://${pdsHost}/xrpc/com.atproto.server.describeServer` : null);
  }

  const record = byLabel.get("Record");
  if (record) links.set("Record", pdsHost ? recordUrl(pdsHost, record.value) : null);

  return links;
}

/** The DID document itself: `plc.directory` for did:plc, the domain for did:web. */
function didDocumentUrl(did: string): string | null {
  if (/^did:plc:[a-z2-7]{24}$/.test(did)) return `https://plc.directory/${did}`;
  if (did.startsWith("did:web:")) {
    // did:web encodes path segments with `:`; the bare form means /.well-known.
    const [domain, ...segments] = did.slice("did:web:".length).split(":");
    const host = hostnameOrNull(decodeURIComponent(domain ?? ""));
    if (!host) return null;
    return segments.length
      ? `https://${host}/${segments.map((part) => encodeURIComponent(decodeURIComponent(part))).join("/")}/did.json`
      : `https://${host}/.well-known/did.json`;
  }
  return null;
}

/** The `at://` record as the PDS read it, so a reader sees the same bytes. */
function recordUrl(pdsHost: string, uri: string): string | null {
  const match = /^at:\/\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/([a-zA-Z0-9.]+)\/(.+)$/.exec(uri);
  if (!match) return null;
  const [, did, collection, rkey] = match;
  const query = new URLSearchParams({ repo: did, collection, rkey });
  return `https://${pdsHost}/xrpc/com.atproto.repo.getRecord?${query.toString()}`;
}

/** The value read strictly as a hostname, so it can only ever be an origin. */
function hostnameOrNull(value: string): string | null {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(value)) {
    return null;
  }
  return value.toLowerCase();
}

// Destinations for the proven half of an attestation.
//
// These values were read out of a Fulcio certificate that verified against
// Sigstore's root, so the repository, ref, commit and run are facts a reader
// can go check rather than claims to take on faith. The declared half is
// linked too (see `BuildProvenance`), but it is only ever the publisher's own
// statement — which is why the two halves stay visually separated and the
// explanation line says plainly when they disagree. A reader told the declared
// publisher does not match is exactly the reader who needs to go look at it.
//
// Every href is rebuilt from parsed, re-validated parts rather than
// interpolated from the raw string, so a certificate carrying anything other
// than a public github.com repository degrades to text instead of emitting
// whatever it happened to say.
export function attestationLinks(build: NonNullable<PublicDiffAttestation["build"]>) {
  const repo = githubRepoUrl(build.repository);
  // The certificate spells a fully-qualified ref; GitHub resolves the bare
  // branch or tag name under /tree.
  const refName = build.ref?.replace(/^refs\/(?:heads|tags)\//, "") ?? null;
  const commit = build.commit && /^[0-9a-f]{7,64}$/i.test(build.commit) ? build.commit : null;
  // Workflow pins to the commit the certificate proves, not to a moving
  // branch: the point of the row is which file ran for *this* release.
  const workflowRev = commit ?? refName;
  return {
    repo,
    workflow:
      repo && build.workflow && workflowRev
        ? `${repo}/blob/${encodePath(workflowRev)}/${encodePath(build.workflow)}`
        : null,
    ref: repo && refName ? `${repo}/tree/${encodePath(refName)}` : null,
    commit: repo && commit ? `${repo}/commit/${commit}` : null,
    run: githubUrl(build.runUrl),
    // Rekor indices are local to one log. Link the exact instance whose pinned
    // key authenticated this entry. Rekor v2 exposes immutable entry bundles
    // through the tiled-log read API rather than Rekor v1's lookup endpoint.
    rekor: rekorEvidenceUrl(build.logBaseUrl, build.logIndex),
  };
}

function rekorEvidenceUrl(baseUrl: string, logIndex: string | null): string | null {
  if (!logIndex || !/^\d{1,20}$/.test(logIndex)) return null;
  const index = BigInt(logIndex);
  if (index > 0xffff_ffff_ffff_ffffn) return null;
  if (baseUrl === "https://rekor.sigstore.dev") {
    return `${baseUrl}/api/v1/log/entries?logIndex=${logIndex}`;
  }
  if (baseUrl !== "https://log2025-1.rekor.sigstore.dev") return null;

  if (index > 0x7fff_ffff_ffff_ffffn) return null;
  let tileIndex = index / 256n;
  const elements: string[] = [];
  do {
    elements.unshift((tileIndex % 1000n).toString().padStart(3, "0"));
    tileIndex /= 1000n;
  } while (tileIndex > 0n);
  const tilePath = elements
    .map((element, position) => (position < elements.length - 1 ? `x${element}` : element))
    .join("/");
  return `${baseUrl}/tile/entries/${tilePath}`;
}

/** `https://github.com/<owner>/<repo>`, rebuilt from the parsed URL, or null. */
export function githubRepoUrl(repository: string): string | null {
  const url = githubUrl(repository);
  if (!url) return null;
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  if (segments.length !== 2) return null;
  return `https://github.com/${encodePath(segments.join("/"))}`;
}

/** A value echoed as a link only if it really is an https github.com URL. */
function githubUrl(value: string | null): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") return null;
  return url.toString();
}

/** Encode each path segment while leaving the separators intact. */
export function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}
