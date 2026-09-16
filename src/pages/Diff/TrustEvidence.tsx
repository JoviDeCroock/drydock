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
import {
  attestationLinks,
  encodePath,
  githubRepoUrl,
  resolutionLinks,
} from "../../lib/trust-links";
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
