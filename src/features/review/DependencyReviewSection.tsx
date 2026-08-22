import type { ComponentChildren } from "preact";
import type {
  DependencyEvidence,
  DependencyReview,
} from "../../../server/lib/review/dependency-evidence";
import { Badge, type BadgeTone } from "../../components/Badge";
import { EmptyLine, SectionLabel } from "../../components/Typography";

// The dependencies a release newly introduces, and what Drydock found inside
// their bytes. Shared by the authenticated scan workbench and the public
// report so both read the same evidence.
//
// The section exists to answer one question honestly: what third-party code
// does approving this release start shipping to consumers? That means the
// resolution has to be labelled as a review-time *snapshot*. An exact spec
// pins the version coordinate more tightly, but only the recorded digest says
// which bytes Drydock actually reviewed.
export function DependencyReviewSection({ review }: { review: DependencyReview }) {
  if (review.status === "not-applicable" || !review.dependencies.length) return null;

  return (
    <section class="flex flex-col gap-3 min-w-0">
      <SectionLabel as="h2" aside={countLabel(review)}>
        New dependencies
      </SectionLabel>
      <p class="m-0 text-[13px] leading-[1.55] text-ink-muted max-w-[760px]">
        Dependencies this release adds to consumer installs. Drydock attempts to fetch and scan each
        published artifact without installing or running it; rows marked not reviewed need a manual
        look. Versions below are what a consumer install would resolve at review time, not a
        permanent record of what they will get.
      </p>
      <ul class="list-none p-0 m-0 border border-border rounded-lg overflow-hidden divide-y divide-border">
        {review.dependencies.map((dependency) => (
          <DependencyRow key={`${dependency.name}@${dependency.declaredSpec}`} {...dependency} />
        ))}
      </ul>
      {review.status === "partial" ? <EmptyLine>{partialReviewCopy(review)}</EmptyLine> : null}
    </section>
  );
}

function partialReviewCopy(review: DependencyReview): string {
  if (review.dependencies.some((dependency) => dependency.reason === "review-failed")) {
    return "Dependency review did not complete. The dependencies marked not reviewed need a manual look before approving.";
  }
  return "Dependency review did not cover every selected dependency. The ones marked not reviewed need a manual look before approving.";
}

function DependencyRow(dependency: DependencyEvidence) {
  return (
    <li class="flex flex-col gap-2 px-3 py-3 min-w-0">
      <div class="flex flex-wrap items-center gap-2 min-w-0">
        <Badge tone={verdictTone(dependency)}>{verdictLabel(dependency)}</Badge>
        <code class="font-mono text-[13px] text-ink break-all min-w-0">
          {dependency.name}
          <span class="text-ink-subtle">@{dependency.declaredSpec}</span>
        </code>
        <Badge tone="neutral">{dependency.section}</Badge>
      </div>

      <p class="m-0 text-[13px] leading-[1.55] text-ink-muted min-w-0">
        {describeDependency(dependency)}
      </p>

      <dl class="m-0 grid grid-cols-[132px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
        <DetailRow label="resolved">
          {dependency.resolvedVersion ? (
            <>
              <code class="font-mono text-[12px] text-ink-muted">{dependency.resolvedVersion}</code>{" "}
              <span class="text-ink-subtle">{resolutionQualifier(dependency)}</span>
            </>
          ) : (
            <span class="text-ink-subtle">not resolved</span>
          )}
        </DetailRow>
        {dependency.automaticExecution.length ? (
          <DetailRow label="runs on install">
            <code class="font-mono text-[12px] text-ink-muted break-all">
              {dependency.automaticExecution
                .map((entry) => (entry.kind === "script" ? `scripts.${entry.name}` : entry.name))
                .join(", ")}
            </code>
          </DetailRow>
        ) : null}
        {dependency.reviewedDigest ? (
          <DetailRow label="reviewed bytes">
            <code class="font-mono text-[11px] text-ink-muted break-all min-w-0">
              {dependency.reviewedDigest.algorithm}-{dependency.reviewedDigest.value}
            </code>
          </DetailRow>
        ) : null}
      </dl>
    </li>
  );
}

function DetailRow({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <>
      <dt class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle m-0">{label}</dt>
      <dd class="m-0 min-w-0 break-words">{children}</dd>
    </>
  );
}

function countLabel(review: DependencyReview): string {
  const noun = review.selectedCount === 1 ? "dependency" : "dependencies";
  if (review.uninspectableCount === 0) return `${review.selectedCount} ${noun} reviewed`;
  return `${review.inspectedCount}/${review.selectedCount} ${noun} reviewed`;
}

function verdictTone(dependency: DependencyEvidence): BadgeTone {
  if (dependency.digestVerified === false) return "critical";
  if (dependency.status === "uninspectable") return "medium";
  if (dependency.verdict === "install-risk") return "critical";
  if (dependency.verdict === "install-execution") return "medium";
  return "ok";
}

function verdictLabel(dependency: DependencyEvidence): string {
  if (dependency.digestVerified === false) return "integrity mismatch";
  if (dependency.status === "uninspectable") return "not reviewed";
  if (dependency.verdict === "install-risk") return "install-time risk";
  if (dependency.verdict === "install-execution") return "runs on install";
  return "reviewed";
}

function describeDependency(dependency: DependencyEvidence): string {
  if (dependency.digestVerified === false) {
    return "The fetched artifact does not match the digest advertised by the registry. Treat this review as invalid until the integrity failure is resolved.";
  }
  if (dependency.status === "uninspectable")
    return UNINSPECTABLE_COPY[dependency.reason ?? "other"];
  if (dependency.verdict === "install-risk") {
    return "Installing this package runs code that downloads, evaluates, or reads credentials. Review it directly before approving the release.";
  }
  if (dependency.verdict === "install-execution") {
    return "Installing this package executes a lifecycle or build step. Nothing in that step matched a downloader or credential pattern.";
  }
  return "Nothing in this package runs automatically on install.";
}

// Keyed by `DependencyUninspectableReason`, plus an `other` fallback for a
// persisted record whose reason did not survive re-validation.
const UNINSPECTABLE_COPY: Record<string, string> = {
  "unresolvable-spec":
    "The declared spec does not point at a registry version Drydock can fetch, so none of this dependency's code was reviewed.",
  "no-matching-version":
    "No published version satisfies this spec, so none of this dependency's code was reviewed.",
  "metadata-unavailable":
    "The registry returned nothing for a credential-free request. A private or internal-scope dependency has to be reviewed by hand — Drydock never sends your npm token to fetch a dependency.",
  "artifact-unavailable": "The dependency's artifact could not be downloaded, so it was not read.",
  "artifact-too-large": "The dependency's artifact is past the scanner's size limits.",
  "artifact-unparseable": "The dependency's artifact could not be parsed as a package archive.",
  "artifact-truncated":
    "At least one dependency file exceeded the retained detection sample, so Drydock did not treat the partial bytes as a complete review.",
  "budget-exhausted":
    "The dependency review budget expired before this package could be read, or the release exceeded the per-review dependency limit.",
  "review-failed":
    "The dependency review failed before Drydock could inspect this package. Review it by hand before approving.",
  other: "Drydock could not review this dependency's own bytes.",
};

// An exact spec pins the version coordinate, not the artifact bytes. The
// recorded digest is the only byte-level evidence, and custom registries can
// mutate a version in place.
function resolutionQualifier(dependency: DependencyEvidence): string {
  switch (dependency.declarationKind) {
    case "exact":
      return "— exact version selected at review time; digest records the reviewed bytes";
    case "tag":
      return "— dist-tag, so this can point at different bytes later";
    case "unusual":
      return "— resolved outside normal registry ranges";
    default:
      return "— review-time snapshot; the range admits other versions later";
  }
}
