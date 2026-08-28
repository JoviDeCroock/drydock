import type { ComponentChildren } from "preact";
import type {
  DependencyEvidence,
  ReviewedDependencyEvidence,
  DependencyReview,
} from "../../../server/lib/review/dependency-evidence";
import {
  classifyDependencyInstallRisk,
  dependencyDeclarationKey,
} from "../../../server/lib/review/dependency-evidence";
import { Badge, type BadgeTone } from "../../components/Badge";
import { EmptyLine, SectionLabel } from "../../components/Typography";
import { dependencyEvidenceDomId } from "../../lib/dependency-evidence-navigation";

// The dependencies a release newly introduces, and what Drydock found inside
// their bytes. Shared by the authenticated scan workbench and the public
// report so both read the same evidence.
//
// The section exists to answer one question honestly: what third-party code
// does approving this release start shipping to consumers? That means the
// resolution has to be labelled as a review-time *snapshot*. An exact spec
// pins the version coordinate more tightly, but only the recorded digest says
// which bytes Drydock actually reviewed.
export function DependencyReviewSection({
  review,
  evidence = [],
}: {
  review?: DependencyReview | null;
  evidence?: DependencyEvidence[];
}) {
  if (evidence.length) return <DependencyEvidenceSection review={review} evidence={evidence} />;
  if (!review) return null;
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
          <DependencyRow
            key={dependencyDeclarationKey(
              dependency.name,
              dependency.section,
              dependency.declaredSpec,
            )}
            {...dependency}
          />
        ))}
      </ul>
      {review.status === "partial" ? <EmptyLine>{partialReviewCopy(review)}</EmptyLine> : null}
    </section>
  );
}

function DependencyEvidenceSection({
  review,
  evidence,
}: {
  review?: DependencyReview | null;
  evidence: DependencyEvidence[];
}) {
  const evidenceKeys = new Set(
    evidence.map((entry) =>
      dependencyDeclarationKey(entry.name, entry.section, entry.declaredSpec),
    ),
  );
  const additionalDependencies = (review?.dependencies ?? []).filter(
    (dependency) =>
      !evidenceKeys.has(
        dependencyDeclarationKey(dependency.name, dependency.section, dependency.declaredSpec),
      ),
  );
  const inspected =
    review?.inspectedCount ?? evidence.filter((entry) => entry.outcome === "inspected").length;
  const selected = review?.selectedCount ?? evidence.length;
  return (
    <section class="flex flex-col gap-3 min-w-0">
      <SectionLabel as="h2" aside={`${inspected}/${selected} reviewed`}>
        New dependencies
      </SectionLabel>
      <p class="m-0 text-[13px] leading-[1.55] text-ink-muted max-w-[760px]">
        Drydock obtained these newly added direct dependencies from credential-free registry reads
        or their exact bundled bytes, then scanned them without installing or executing package
        code. Range and dist-tag resolutions are review-time snapshots, not provenance.
      </p>
      <ul class="list-none p-0 m-0 border border-border rounded-lg overflow-hidden divide-y divide-border">
        {evidence.map((entry) => (
          <li
            id={dependencyEvidenceDomId(entry)}
            data-dependency-name={entry.name}
            key={JSON.stringify([entry.section, entry.name, entry.declaredSpec])}
            class="flex flex-col gap-2 px-3 py-3 min-w-0 scroll-mt-6"
          >
            <div class="flex flex-wrap items-center gap-2 min-w-0">
              <Badge tone={entry.outcome === "inspected" ? "ok" : "medium"}>
                {entry.outcome === "inspected" ? "reviewed" : "manual review required"}
              </Badge>
              <code class="font-mono text-[13px] text-ink break-all min-w-0">
                {entry.name}@{entry.resolution?.version ?? "unresolved"}
              </code>
              <Badge tone="neutral">{entry.section}</Badge>
              <Badge tone="neutral">{resolutionLabel(entry)}</Badge>
            </div>
            <p class="m-0 text-[13px] leading-[1.55] text-ink-muted">
              {entry.outcome === "inspected"
                ? entry.path
                : `Unreviewed code: ${entry.outcomeDetail || entry.outcome}. Verify this dependency manually before approving.`}
            </p>
            <dl class="m-0 grid grid-cols-[132px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
              {entry.entrypoints?.lifecycleScripts.length ? (
                <DetailRow label="runs on install">
                  <code class="font-mono text-[12px] text-ink-muted break-all">
                    {entry.entrypoints.lifecycleScripts.join(", ")}
                  </code>
                </DetailRow>
              ) : null}
              {entry.artifact?.sha512 ? (
                <DetailRow label="reviewed bytes">
                  <details>
                    <summary class="font-mono text-[11px] text-ink-muted cursor-pointer">
                      sha512 digest
                    </summary>
                    <code class="font-mono text-[11px] text-ink-muted break-all">
                      {entry.artifact.sha512}
                    </code>
                  </details>
                </DetailRow>
              ) : null}
              <DetailRow label="findings">{entry.findingCount}</DetailRow>
            </dl>
          </li>
        ))}
        {additionalDependencies.map((dependency) => (
          <DependencyRow
            key={dependencyDeclarationKey(
              dependency.name,
              dependency.section,
              dependency.declaredSpec,
            )}
            {...dependency}
          />
        ))}
      </ul>
      {review?.status === "partial" ? <EmptyLine>{partialReviewCopy(review)}</EmptyLine> : null}
    </section>
  );
}

function resolutionLabel(entry: DependencyEvidence): string {
  if (!entry.resolution) {
    if (entry.outcome === "metadata-unavailable") return "metadata unavailable";
    if (entry.outcome === "no-matching-version") return "no matching version";
    return entry.outcome;
  }
  if (entry.resolution.kind === "exact") return `pinned ${entry.resolution.version}`;
  if (entry.resolution.kind === "dist-tag") return `dist-tag ${entry.declaredSpec || "latest"}`;
  return `resolved from range ${entry.declaredSpec}`;
}

function partialReviewCopy(review: DependencyReview): string {
  if (review.dependencies.some((dependency) => dependency.reason === "review-failed")) {
    return "Dependency review did not complete. The dependencies marked not reviewed need a manual look before approving.";
  }
  return "Dependency review did not cover every selected dependency. The ones marked not reviewed need a manual look before approving.";
}

function DependencyRow(dependency: ReviewedDependencyEvidence) {
  return (
    <li
      id={dependencyEvidenceDomId(dependency)}
      data-dependency-name={dependency.name}
      class="flex flex-col gap-2 px-3 py-3 min-w-0 scroll-mt-6"
    >
      <div class="flex flex-wrap items-center gap-2 min-w-0">
        <Badge tone={observationTone(dependency)}>{observationLabel(dependency)}</Badge>
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

function observationTone(dependency: ReviewedDependencyEvidence): BadgeTone {
  if (dependency.digestVerified === false) return "critical";
  const installRisk =
    dependency.observation.execution === "observed"
      ? classifyDependencyInstallRisk(dependency)
      : null;
  if (installRisk) return installRisk.severity;
  if (dependency.observation.execution === "observed") return "medium";
  if (dependency.status === "uninspectable") return "medium";
  return "ok";
}

function observationLabel(dependency: ReviewedDependencyEvidence): string {
  if (dependency.digestVerified === false) return "integrity mismatch";
  if (dependency.observation.execution === "observed") {
    if (dependency.observation.risk === "observed") return "install-time risk";
    if (dependency.observation.risk === "unknown") return "risk unknown";
    return "runs on install";
  }
  if (dependency.status === "uninspectable") return "not reviewed";
  return "reviewed";
}

function describeDependency(dependency: ReviewedDependencyEvidence): string {
  if (dependency.digestVerified === false) {
    return "The fetched artifact does not match the digest advertised by the registry. Treat this review as invalid until the integrity failure is resolved.";
  }
  const installRisk =
    dependency.observation.execution === "observed"
      ? classifyDependencyInstallRisk(dependency)
      : null;
  if (installRisk?.nativeExecution) {
    return dependencyDescriptionWithCoverageGap(
      dependency,
      "Installing this package can invoke a native executable. Confirm that the binary and process launch are expected before approving the release.",
    );
  }
  if (installRisk?.certainty === "observed") {
    return dependencyDescriptionWithCoverageGap(
      dependency,
      installRisk.strong
        ? "Installing this package reaches remote-shell, credential-access, dynamic-evaluation, or embedded-secret behavior. Review it directly before approving the release."
        : "Installing this package reaches network-capable code. Confirm what it downloads and from where before approving the release.",
    );
  }
  if (installRisk) {
    return dependencyDescriptionWithCoverageGap(
      dependency,
      installRisk.strong
        ? "This package runs code during install and also contains remote-shell, credential-access, dynamic-evaluation, or embedded-secret behavior, but Drydock could not prove the install hook reaches it. Review the package directly before approving."
        : "This package runs code during install and contains network-capable code elsewhere, but Drydock could not prove the install hook reaches it.",
    );
  }
  if (dependency.observation.execution === "observed") {
    return dependencyDescriptionWithCoverageGap(
      dependency,
      "Installing this package executes a lifecycle or build step. Nothing in the retained install path matched a downloader or credential pattern.",
    );
  }
  if (dependency.status === "uninspectable")
    return UNINSPECTABLE_COPY[dependency.reason ?? "other"];
  return "Drydock did not observe automatic install execution in the reviewed bytes.";
}

function dependencyDescriptionWithCoverageGap(
  dependency: ReviewedDependencyEvidence,
  knownBehavior: string,
): string {
  return dependency.status === "uninspectable"
    ? `${knownBehavior} ${UNINSPECTABLE_COPY[dependency.reason ?? "other"]}`
    : knownBehavior;
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
  "artifact-ambiguous":
    "The dependency archive contains links, duplicate paths, or visually-confusable paths that cannot be represented as ordinary reviewed files.",
  "artifact-truncated":
    "At least one dependency file exceeded the retained detection sample, so Drydock did not treat the partial bytes as a complete review.",
  "manifest-unavailable":
    "The dependency artifact has no readable root package.json, so Drydock could not determine what it runs during install.",
  "budget-exhausted":
    "The dependency review budget expired before this package could be read, or the release exceeded the per-review dependency limit.",
  "review-failed":
    "The dependency review failed before Drydock could inspect this package. Review it by hand before approving.",
  other: "Drydock could not review this dependency's own bytes.",
};

// An exact spec pins the version coordinate, not the artifact bytes. The
// recorded digest is the only byte-level evidence, and custom registries can
// mutate a version in place.
function resolutionQualifier(dependency: ReviewedDependencyEvidence): string {
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
