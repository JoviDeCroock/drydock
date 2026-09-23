import type { ComponentChildren } from "preact";
import type { ReleaseProvenance, StagedArtifactIntegrity } from "../../../../server/types";
import { ecosystemLabel } from "../../../../server/lib/ecosystems/labels";
import { parseStagedArtifactIntegrity } from "../../../../server/lib/ecosystems/artifact-integrity";
import {
  normalizeGateContinuity,
  type GateContinuity,
  type GateContinuityReason,
} from "../../../../server/lib/scan/gate-continuity-record";
import { Badge, type BadgeTone } from "../../../components/Badge";
import { manifestVersionRange, PackageJsonDiffView } from "../../../components/PackageJsonDiffView";
import { EmptyLine, SectionLabel } from "../../../components/Typography";
import type { PersistedSummary } from "./types";

export function PersistedReportSections({ summary }: { summary: PersistedSummary }) {
  const artifactIntegrity = parseStagedArtifactIntegrity(summary.stagedPublish?.artifactIntegrity);
  // The manifest pair is the persisted default baseline, which can differ from
  // the version the picker above currently compares against, so it stays.
  const manifestRange = summary.packageJsonDiff
    ? manifestVersionRange(summary.packageJsonDiff)
    : null;
  const gateContinuity = normalizeGateContinuity(summary.gateContinuity);
  return (
    <section class="flex flex-col gap-6">
      <ReportSection
        title="Manifest changes"
        id="manifest-changes"
        aside={
          manifestRange ? (
            <>
              version <span class="normal-case">{manifestRange}</span>
            </>
          ) : null
        }
      >
        {summary.packageJsonDiff ? (
          <PackageJsonDiffView
            diff={summary.packageJsonDiff}
            // PyPI dependencies are not npm packages, so the public npm diff
            // view cannot show them; npm and VS Code manifests both resolve
            // their dependencies from the npm registry. A gated scan names its
            // ecosystem under `provenance`, a published-pair review names it
            // directly, and scans persisted before either are npm.
            linkDependencyDiffs={
              (summary.stagedPublish?.provenance?.ecosystem ?? summary.stagedPublish?.ecosystem) !==
              "pypi"
            }
          />
        ) : (
          <EmptyLine>No manifest changes were saved for this review.</EmptyLine>
        )}
      </ReportSection>

      {summary.stagedPublish?.provenance?.artifacts?.length ? (
        <ReportSection title="Provenance">
          <ProvenanceView provenance={summary.stagedPublish.provenance} />
        </ReportSection>
      ) : null}

      {/* The reviewer's narrative verdict used to sit here, at the bottom of the
          page. It moved up to `ReviewerSummary`, directly under the
          Recommendation — it answers "what is this release?", which is the
          question the page opens with, not a footnote to it. */}

      {artifactIntegrity ? (
        <ReportSection title="Artifact verification">
          <ArtifactIntegrityView integrity={artifactIntegrity} />
        </ReportSection>
      ) : null}

      {gateContinuity ? (
        <ReportSection title="Gate continuity">
          <GateContinuityView
            continuity={gateContinuity}
            boundToRegistry={artifactIntegrity?.status === "verified"}
          />
        </ReportSection>
      ) : null}
    </section>
  );
}

// Each non-binding outcome has a different cause and asks something different
// of the maintainer, so the copy names the cause rather than a generic "one of
// the digests is unavailable".
const UNBOUND_DESCRIPTIONS: Record<GateContinuityReason, string> = {
  "gate-review-incomplete":
    "A workflow-gate review of this version exists but has not completed — it is still running, or it failed — so the gate has approved no bytes for this version yet. Do not approve this stage on npm until the gate review completes and matches.",
  "staged-digest-unavailable":
    "The workflow gate reviewed this version, but Drydock computed no SHA-256 for the staged tarball, so the stage is not bound to the gated review.",
  "gate-digest-unavailable":
    "The workflow gate reviewed this version, but no review recorded a single npm tarball digest (a multi-artifact bundle, or a review older than gate provenance), so the stage is not bound to it.",
  "gate-decision-unavailable":
    "The workflow gate reviewed exactly these bytes, but its gate record has since been deleted, so whether it approved them is unknown.",
  "stage-not-bound-to-registry":
    "The tarball Drydock downloaded is the tarball the workflow gate approved, but the download was not confirmed against npm's own record for this stage (see Artifact verification), so this does not show what npm holds.",
  "review-window-truncated":
    "The workflow gate reviewed this version more often than Drydock compares, and none of the most recent reviews match the staged bytes. An older one might, so the stage is neither bound to a review nor accused.",
  "history-unavailable":
    "Drydock could not read this organization's workflow-gate history when it scanned this stage, so whether the stage went through the gate is unknown. If this package is gated, confirm the gate reviewed this version before approving on npm.",
  "registry-record-unavailable":
    "npm's record for this stage was unavailable, and the name inside the tarball is not trusted to look up gate history, so whether the stage went through the gate is unknown. If this package is gated, confirm the gate reviewed this version before approving on npm.",
};

function describeGateContinuity(continuity: GateContinuity, npmHolds: boolean): string {
  if (continuity.reason) return UNBOUND_DESCRIPTIONS[continuity.reason];
  switch (continuity.status) {
    case "matched":
      return "The tarball npm holds for this stage is byte-for-byte the tarball the workflow gate reviewed and approved. Approving on npm publishes the gated bytes.";
    case "gate-not-approved":
      return "The workflow gate reviewed exactly these bytes and did not approve them (rejected, or not yet decided), yet they were staged. Reject this stage on npm.";
    case "digest-mismatch":
      return `The workflow gate reviewed this version, but the ${npmHolds ? "tarball npm holds" : "tarball Drydock downloaded for this stage"} hashes differently: bytes the gate never saw. Do not approve on npm on the strength of the gated review.`;
    case "ungated":
      return "A release target this organization still has configured has gated this package before, and no gate review exists for this version. The stage was produced outside the gated workflow; reject it on npm unless it was staged on purpose.";
    case "unverified":
      return "The workflow gate reviewed this version, but the stage could not be bound to its review.";
    case "unknown":
      return "Drydock could not check this stage against the organization's workflow-gate history.";
  }
}

/**
 * What the Gate continuity section says and how loudly. Pure so the tone and
 * wording rules can be tested without rendering.
 */
export function gateContinuityPresentation(
  continuity: GateContinuity,
  /** Whether the staged bytes were confirmed against npm's own record for the stage. */
  boundToRegistry: boolean,
): { tone: BadgeTone; description: string; stagedLabel: string } {
  // "npm holds" is a claim about the registry, which only a download
  // confirmed against npm's stage record can make. `matched` is only ever
  // evaluated for a confirmed download.
  const npmHolds = continuity.status === "matched" || boundToRegistry;
  // Only a matched stage is good news. A mismatch is an accusation backed by
  // two digests, so it reads as critical; an ungated stage of a gated package
  // is the out-of-band signal and reads as a warning, never as neutral. A
  // stage whose only gate review has not completed has no approval behind it
  // either, so it is never quieter than `ungated`. A stage that could not be
  // bound or checked is never quieter than amber.
  const tone =
    continuity.status === "matched"
      ? "ok"
      : continuity.status === "digest-mismatch" || continuity.status === "gate-not-approved"
        ? "critical"
        : continuity.status === "ungated" || continuity.reason === "gate-review-incomplete"
          ? "high"
          : "medium";
  return {
    tone,
    description: describeGateContinuity(continuity, npmHolds),
    stagedLabel: npmHolds ? "npm holds" : "staged download",
  };
}

function GateContinuityView({
  continuity,
  boundToRegistry,
}: {
  continuity: GateContinuity;
  boundToRegistry: boolean;
}) {
  const review = continuity.review;
  const { tone, description, stagedLabel } = gateContinuityPresentation(
    continuity,
    boundToRegistry,
  );
  const gateLabel = review
    ? [review.repository, review.environment, review.runId ? `run ${review.runId}` : null]
        .filter(Boolean)
        .join(" · ")
    : null;
  const decisionLabel = review?.decision
    ? `${review.decision}${review.decidedAt ? ` · ${new Date(review.decidedAt).toLocaleString()}` : ""}`
    : (review?.status ?? (review?.gateId === null ? "record deleted" : null));
  return (
    <div class="flex flex-col gap-3">
      <div class="flex flex-wrap gap-2">
        <Badge tone={tone}>{continuity.status}</Badge>
        <Badge tone="neutral">{continuity.algorithm}</Badge>
      </div>
      <p class="m-0 text-[13px] leading-[1.6] text-ink-muted">{description}</p>
      <div class="border border-border rounded-lg overflow-hidden divide-y divide-border">
        {review ? (
          <div class="flex flex-col gap-1.5 px-3 py-2.5 min-w-0">
            <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
              gate review
            </span>
            <a
              href={`/dashboard/scans/${encodeURIComponent(review.scanId)}`}
              class="text-[13px] text-ink underline-offset-2 hover:underline break-all min-w-0"
            >
              {gateLabel || review.scanId}
            </a>
            {decisionLabel ? (
              <span class="text-[12px] text-ink-muted">gate {decisionLabel}</span>
            ) : null}
          </div>
        ) : null}
        {review ? <DigestRow label="gate reviewed" value={review.sha256} /> : null}
        <DigestRow label={stagedLabel} value={continuity.stagedDigest} />
      </div>
    </div>
  );
}

function ReportSection({
  title,
  aside,
  children,
  class: className,
  id,
}: {
  title: string;
  aside?: ComponentChildren;
  children: ComponentChildren;
  class?: string;
  id?: string;
}) {
  return (
    <section
      id={id}
      tabIndex={id ? -1 : undefined}
      class={`flex flex-col gap-3 min-w-0 ${className || ""}`}
    >
      <SectionLabel as="h2" aside={aside}>
        {title}
      </SectionLabel>
      {children}
    </section>
  );
}

function ArtifactIntegrityView({ integrity }: { integrity: StagedArtifactIntegrity }) {
  // The expected outcome is one plain line: two identical digests in two
  // bordered rows made the reader compare 40 hex characters to learn "yes".
  // Anything else keeps both digests side by side, because there the
  // difference is the evidence.
  if (integrity.status === "verified" && integrity.computed) {
    return (
      <p class="m-0 font-mono text-[11px] text-ink-subtle flex flex-wrap items-baseline gap-x-2 gap-y-1 min-w-0">
        <span class="text-ink-muted">verified</span>
        <span aria-hidden>·</span>
        <span class="break-all min-w-0">
          {integrity.algorithm} {integrity.computed}
        </span>
        <span aria-hidden>·</span>
        <span>matches npm&rsquo;s stage record</span>
      </p>
    );
  }
  const description =
    integrity.status === "verified"
      ? "The reviewed tarball bytes match the SHA-1 npm recorded for this staged release."
      : integrity.status === "mismatch"
        ? "The reviewed tarball bytes do not match npm's stage record. Treat this report as describing a different artifact."
        : integrity.reason === "declared-digest-missing"
          ? "npm did not provide a valid staged-tarball digest, so Drydock could not bind this review to the staged bytes."
          : integrity.reason === "stage-record-confirmation-unavailable"
            ? "Drydock saw a digest mismatch but could not confirm it against a fresh stage record, so this review remains unverified."
            : "Drydock could not hash the complete tarball stream, so this review is not bound to npm's stage record.";
  // A registry that published no digest is an absence of evidence, and the
  // report must not tone it as a warning about the release: that is the same
  // mistake as raising a finding for it. Only a digest Drydock failed to
  // compute — something on our side went wrong — reads as amber.
  const tone =
    integrity.status === "verified"
      ? "ok"
      : integrity.status === "mismatch"
        ? "critical"
        : integrity.reason === "declared-digest-missing"
          ? "neutral"
          : "medium";

  return (
    <div class="flex flex-col gap-3">
      <div class="flex flex-wrap gap-2">
        <Badge tone={tone}>{integrity.status}</Badge>
        <Badge tone="neutral">{integrity.algorithm}</Badge>
      </div>
      <p class="m-0 text-[13px] leading-[1.6] text-ink-muted">{description}</p>
      <div class="border border-border rounded-lg overflow-hidden divide-y divide-border">
        <DigestRow label="npm recorded" value={integrity.declared} />
        <DigestRow label="reviewed bytes" value={integrity.computed} />
      </div>
    </div>
  );
}

function DigestRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div class="flex flex-col gap-1.5 px-3 py-2.5 min-w-0">
      <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">{label}</span>
      {value ? (
        <code class="font-mono text-[11px] text-ink-muted break-all min-w-0">{value}</code>
      ) : (
        <span class="text-[12px] text-ink-muted">not available</span>
      )}
    </div>
  );
}

function ProvenanceView({ provenance }: { provenance: ReleaseProvenance }) {
  const ecosystem = ecosystemLabel(provenance.ecosystem);
  return (
    <div class="flex flex-col gap-3">
      <p class="m-0 text-[13px] leading-[1.6] text-ink-muted">
        SHA-256 digests recomputed from the reviewed {ecosystem} release bytes. The publish job
        re-verifies these against the immutable artifact before upload, so the bytes reviewed are
        the bytes published.
      </p>
      <div class="border border-border rounded-lg overflow-hidden divide-y divide-border">
        {provenance.artifacts.map((artifact) => (
          <div key={artifact.path} class="flex flex-col gap-1.5 px-3 py-2.5 min-w-0">
            <div class="flex flex-wrap items-center gap-2 min-w-0">
              <Badge tone="neutral">{artifact.kind}</Badge>
              <code class="font-mono text-[12px] text-ink break-all min-w-0">{artifact.path}</code>
            </div>
            <div class="flex items-baseline gap-2 min-w-0">
              <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle shrink-0">
                sha256
              </span>
              <code class="font-mono text-[11px] text-ink-muted break-all min-w-0">
                {artifact.sha256}
              </code>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
