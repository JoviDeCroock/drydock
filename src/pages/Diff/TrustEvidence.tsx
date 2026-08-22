/**
 * Trust evidence for an anonymous /diff.
 *
 * A release carries two independent claims, and this renders both without
 * collapsing them into a single verdict: where the reviewed bytes were
 * resolved from (a chain of authorities the reader can re-walk themselves)
 * and who built them (a signature check). The link builders are exported
 * because every URL here points off-site, and a wrong one sends a reader
 * somewhere that looks authoritative and is not.
 */
import { Badge } from "../../components/Badge";
import { Card } from "../../components/Card";
import { cn } from "../../components/cn";
import { MonoLabel, Muted } from "../../components/Typography";
import type { PublicDiffAttestation, PublicDiffResponse } from "../../models/package-diff";

// The two independent trust claims a release carries, side by side: where the
// reviewed bytes were found, and who built them. They are deliberately not
// collapsed into one verdict — resolution is a chain of authorities the reader
// can re-walk, provenance is a signature check — so each keeps its own column,
// its own heading, and its own caveat line.
export function TrustEvidence({
  provenance,
  attestation,
}: {
  provenance: PublicDiffResponse["provenance"];
  attestation: PublicDiffAttestation | null;
}) {
  const twoUp = Boolean(provenance.length && attestation);
  return (
    <Card padding="none" class="overflow-hidden">
      <div
        class={cn(
          "grid grid-cols-1 divide-y divide-border lg:divide-y-0 lg:divide-x",
          twoUp ? "lg:grid-cols-2" : "lg:grid-cols-1",
        )}
      >
        {provenance.length ? <ResolutionTrail steps={provenance} /> : null}
        {attestation ? <BuildProvenance attestation={attestation} /> : null}
      </div>
    </Card>
  );
}

// A label/value row whose value column is stable: a long run URL wraps inside
// its own column instead of dropping to the gutter and breaking the alignment
// of every row around it. Labels sit above the value on narrow screens, where a
// fixed label column would squeeze DIDs into a two-character ribbon.
function EvidenceRow({
  label,
  value,
  detail,
  detailPrefix,
  href,
  detailHref,
}: {
  label: string;
  value: string;
  detail?: string | null;
  detailPrefix: string;
  /** Destinations for the value and, when it names one of its own, the detail. */
  href?: string | null;
  detailHref?: string | null;
}) {
  return (
    <div class="grid grid-cols-1 gap-x-3 sm:grid-cols-[76px_minmax(0,1fr)] sm:items-baseline">
      <MonoLabel as="dt">{label}</MonoLabel>
      {/* break-words, not break-all: a DID has no break opportunity and splits
          anyway, but readable text like `via plc.directory` stays whole. */}
      <dd class="font-mono text-[12px] text-ink-muted m-0 break-words">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            class="text-ink-muted underline hover:text-ink"
          >
            {value}
          </a>
        ) : (
          value
        )}
        {detail ? (
          <span class="text-ink-subtle">
            {" "}
            {detailPrefix}{" "}
            {detailHref ? (
              <a
                href={detailHref}
                target="_blank"
                rel="noreferrer"
                class="text-ink-subtle underline hover:text-ink"
              >
                {detail}
              </a>
            ) : (
              detail
            )}
          </span>
        ) : null}
      </dd>
    </div>
  );
}

// How the reviewed bytes were located, for ecosystems that resolve a release
// through a chain of independent authorities instead of one registry. On an
// atpm diff this is the substance of the page's claim — a handle proved through
// DNS, a DID through a directory, bytes from the publisher's own server.
//
// Each row links to the artifact that proved it, not to a page about it: the
// TXT record, the DID document, the PDS's own description, the record itself.
// The reader can re-run the resolution rather than take this column's word for
// it, which is the only thing that makes an unauthenticated trail worth
// printing. See `resolutionLinks` for why publisher-chosen hosts are safe to
// send a reader to here.
function ResolutionTrail({ steps }: { steps: PublicDiffResponse["provenance"] }) {
  const links = resolutionLinks(steps);
  return (
    <div class="p-5 flex flex-col gap-3">
      <div class="flex flex-wrap items-center gap-2 min-h-[22px]">
        <MonoLabel as="p">Resolution</MonoLabel>
      </div>
      <dl class="flex flex-col gap-1.5 m-0">
        {steps.map((step) => (
          <EvidenceRow
            key={`${step.label}:${step.value}`}
            label={step.label}
            value={step.value}
            detail={step.detail}
            detailPrefix="via"
            href={links.get(step.label)}
          />
        ))}
      </dl>
      {/* mt-auto: the two columns rarely have the same number of rows, so the
          caveat lines sit on the card's bottom edge together instead of leaving
          the shorter column trailing into blank space. */}
      <Muted class="m-0 mt-auto text-[12px] leading-[1.6]">
        Each step was resolved independently, and each link goes to the record that proved it.
        Everything here is published by the party under review, so it is evidence to check rather
        than a claim to take on trust.
      </Muted>
    </div>
  );
}

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

// Where a release was built, and whether that matches what its publisher said
// should build it.
//
// The two halves are deliberately not collapsed into one verdict. The build
// facts came out of a signature check against Sigstore's root, so they hold
// regardless of anything the package's own record claims; the declaration is the
// publisher's statement of intent, which is only as good as their repository.
// A reader deserves to see which is which, so the block labels the proven side
// and the declared side separately and states plainly when they disagree.
function BuildProvenance({ attestation }: { attestation: PublicDiffAttestation }) {
  const build = attestation.build;
  const declared = attestation.declared;
  const mismatch = isTrustedPublisherMismatch(attestation);
  const links = build ? attestationLinks(build) : null;
  const declaredRepo = declared ? githubRepoUrl(declared.repository) : null;

  return (
    <div class="p-5 flex flex-col gap-3">
      <div class="flex flex-wrap items-center gap-2 min-h-[22px]">
        <MonoLabel as="p">Build provenance</MonoLabel>
        <Badge tone={buildProvenanceTone(attestation)}>{buildProvenanceLabel(attestation)}</Badge>
        {declared?.allowPublish ? <Badge tone="medium">CI publishes unattended</Badge> : null}
      </div>
      {/* Proven and declared are one list with a rule between them: the reader
          compares the two halves, and the rule is what says they are different
          kinds of claim rather than one continuous record. */}
      {build ? (
        <dl class="flex flex-col gap-1.5 m-0">
          <ProvenanceRow label="Repo" value={build.repository} href={links?.repo} />
          {build.workflow ? (
            <ProvenanceRow label="Workflow" value={build.workflow} href={links?.workflow} />
          ) : null}
          {build.ref ? <ProvenanceRow label="Ref" value={build.ref} href={links?.ref} /> : null}
          {build.commit ? (
            <ProvenanceRow label="Commit" value={build.commit} href={links?.commit} />
          ) : null}
          {build.runUrl ? (
            <ProvenanceRow label="Run" value={build.runUrl} href={links?.run} />
          ) : null}
          {build.runnerEnvironment ? (
            <ProvenanceRow label="Runner" value={build.runnerEnvironment} />
          ) : null}
          {build.logIndex ? (
            <ProvenanceRow label="Rekor" value={build.logIndex} href={links?.rekor} />
          ) : null}
        </dl>
      ) : null}
      {declared ? (
        <dl class={cn("flex flex-col gap-1.5 m-0", build && "border-t border-border pt-3")}>
          <ProvenanceRow
            label="Declared"
            value={declared.repository}
            detail={declared.workflow}
            href={declaredRepo}
            // No commit to pin to — the declaration names a pipeline, not a
            // build — so the workflow link tracks the repository's default
            // branch. A 404 here is itself worth seeing: it means the package
            // declares a workflow file that is not there.
            detailHref={
              declaredRepo && declared.workflow
                ? `${declaredRepo}/blob/HEAD/${encodePath(declared.workflow)}`
                : null
            }
          />
        </dl>
      ) : null}
      <Muted class="m-0 mt-auto text-[12px] leading-[1.6]">
        {buildProvenanceExplanation(attestation, mismatch)}
      </Muted>
    </div>
  );
}

function ProvenanceRow({
  label,
  value,
  detail,
  href,
  detailHref,
}: {
  label: string;
  value: string;
  detail?: string;
  href?: string | null;
  detailHref?: string | null;
}) {
  return (
    <EvidenceRow
      label={label}
      value={value}
      detail={detail}
      detailPrefix="·"
      href={href}
      detailHref={detailHref}
    />
  );
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
function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function buildProvenanceTone(attestation: PublicDiffAttestation) {
  if (attestation.status === "invalid" || attestation.status === "mismatch") {
    return "high" as const;
  }
  if (attestation.status === "verified") {
    return isTrustedPublisherMismatch(attestation) ? ("high" as const) : ("ok" as const);
  }
  return "medium" as const;
}

function buildProvenanceLabel(attestation: PublicDiffAttestation) {
  if (attestation.status === "verified") return "verified";
  if (attestation.status === "mismatch") return "different artifact";
  if (attestation.status === "invalid") return "does not verify";
  if (attestation.status === "absent") return "not attested";
  return "not checked";
}

export function buildProvenanceExplanation(attestation: PublicDiffAttestation, mismatch: boolean) {
  if (attestation.status === "invalid") {
    return `This version carries a build attestation that does not verify: ${attestation.reason ?? "unreadable"}. Nothing about where it was built can be concluded from it.`;
  }
  if (attestation.status === "mismatch") {
    return `The signature is valid, but it does not describe this release: ${attestation.reason ?? "the package or digest differs"}. The build details below belong to another artifact.`;
  }
  if (attestation.status === "absent") {
    return attestation.declared
      ? "This package declares a trusted publishing workflow, but this version carries no attestation proving it came from one."
      : "This version carries no build attestation, so where it was built is not recorded.";
  }
  if (attestation.status === "not-evaluated") {
    return "This version's attestation was not checked on this page. Older releases of a package with many versions fall outside the per-record verification budget.";
  }
  if (mismatch) {
    if (attestation.match === "workflow-unverified") {
      return "The signature proves the source repository, but the certificate does not identify the workflow that produced this release, so it cannot be matched to the package's trusted-publisher declaration.";
    }
    return "The signature proves where this release was built, and it is not the pipeline this package's own publisher declared as trusted.";
  }
  if (attestation.match === "match") {
    return "Verified against Sigstore's root, and the repository and workflow match the trusted publisher this package declares. Transparency-log inclusion is not independently checked.";
  }
  if (attestation.match === "unknown-provider") {
    return "Verified against Sigstore's root. The package declares a trusted-publisher provider this deployment cannot evaluate, so the build cannot be compared with that declaration.";
  }
  return "Verified against Sigstore's root. The package declares no trusted publisher to compare it against, so this says where the release was built, not that it was supposed to be built there.";
}

function isTrustedPublisherMismatch(attestation: PublicDiffAttestation): boolean {
  return (
    attestation.match === "repository-mismatch" ||
    attestation.match === "workflow-mismatch" ||
    attestation.match === "workflow-unverified"
  );
}
