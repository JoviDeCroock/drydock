import { findingSentence } from "../../../lib/findings";
import type { ComponentChildren } from "preact";
import { countSeverities, highestFindingRisk, sortFindingsBySeverity } from "../../../lib/findings";
import { pluralize } from "../../../lib/format";
import {
  getReleaseRecommendation,
  type GateOutcome,
  type ReleaseRecommendationCopy,
} from "../recommendation";
import type { DisplayedAiResult } from "../../../../server/lib/ai-review/types";
import { aiVerdictRiskCap } from "../../../../server/lib/review/risk";
import type { PersistedScanDetail } from "../../../models/scan";
import { RELEASE_PROCESS_FINDING_FILE } from "../../../../server/lib/release-fingerprint";
import { parseStagedArtifactIntegrity } from "../../../../server/lib/ecosystems/artifact-integrity";
import { DETERMINISTIC_RULE_IDS } from "../../../../server/lib/review/rules/rule-ids";
import { Badge, severityTone } from "../../../components/Badge";
import { SeverityBar } from "../../../components/SeverityBar";
import { MonoDetail, SectionLabel } from "../../../components/Typography";
import { registryStatusVariant } from "../../../features/registry-status";
import { verdictTextClass } from "../../../features/review/verdict";
import type { FindingWithDiffStatus, ReviewFinding } from "../../../features/review/types";
import type { PersistedSummary } from "./types";

const FIRST_RELEASE_BASELINE_REASONS = new Set(["none", "no-published-baseline"]);

export interface ReleaseVerdict {
  recommendation: ReleaseRecommendationCopy;
  artifactRisk: string;
  releaseRisk: string;
  evidence: Array<{ label: string; value: ComponentChildren }>;
  findingGroups: ReleaseFindingGroup[];
  releaseChanges: string[];
  severityCounts: Record<string, number>;
  findingTotal: number;
  /** Some counted findings are package context rather than release changes. */
  severityIncludesContext: boolean;
  /**
   * Reasons the reviewed artifact may not be the release being decided. They
   * qualify every verdict, so they stay beside it whatever file is open.
   */
  validity: ArtifactValidityCaveat[];
  // Whether the evidence says anything beyond "nothing changed and nothing
  // fired". Drives whether the review notes open by default.
  hasSignals: boolean;
}

export function buildReleaseVerdict({
  detail,
  summary,
  diffCount,
  findingsWithDiffStatus,
  usePersistedRiskSummary,
  isWorkflowGate,
  ai = null,
  comparedVersion = null,
  gateStatus = null,
}: {
  detail: PersistedScanDetail;
  summary: PersistedSummary;
  diffCount: number;
  findingsWithDiffStatus: FindingWithDiffStatus[];
  usePersistedRiskSummary: boolean;
  isWorkflowGate: boolean;
  ai?: DisplayedAiResult | null;
  /** The version the release delta was computed against. */
  comparedVersion?: string | null;
  /** The workflow gate's own state, when this review belongs to one. */
  gateStatus?: string | null;
}): ReleaseVerdict {
  const changedFindings = findingsWithDiffStatus
    .filter((item) => item.releaseDelta)
    .map((item) => item.finding);
  const artifactRisk = detail.riskSummary?.artifactRisk ?? detail.scan.risk;
  const releaseRisk =
    usePersistedRiskSummary && detail.riskSummary
      ? detail.riskSummary.releaseRisk
      : highestFindingRisk(changedFindings);
  const releaseFindingCount =
    usePersistedRiskSummary && detail.riskSummary
      ? detail.riskSummary.releaseFindingCount
      : changedFindings.length;
  const baselineComparisonSkipped = summary.baseline?.comparisonSkipped === "baseline-too-large";
  // Only the acquirers' "nothing published before" reasons mean a first
  // release; a registry error also leaves no baseline version, and calling
  // that "every file is new" would misstate what the comparison missed.
  const firstRelease =
    !baselineComparisonSkipped &&
    !detail.scan.previousVersion &&
    !summary.baseline?.version &&
    FIRST_RELEASE_BASELINE_REASONS.has(summary.baseline?.reason ?? "");
  const recommendation = getReleaseRecommendation(artifactRisk, releaseRisk, releaseFindingCount, {
    target: isWorkflowGate ? "gate" : "npm",
    baselineComparisonSkipped,
    firstRelease,
    // Same reading as the decision dialog, so the verdict and the dialog it
    // opens agree on whether the release is already out.
    published:
      !isWorkflowGate &&
      (detail.postRelease != null ||
        detail.scan.source === "published" ||
        registryStatusVariant(detail.scan) === "published"),
    baselineVersion: comparedVersion,
    gateOutcome: isWorkflowGate ? gateOutcomeFor(gateStatus, detail.scan.decision) : null,
  });
  // `detail.findings` and `changedFindings` already include the AI reviewer's
  // findings (persisted as `source: "ai"` rows), so they are counted and shown
  // as evidence from that single source — concatenating `ai.findings` from the
  // review envelope on top would double-count every AI finding.
  const evidence = buildRecommendationEvidence(
    detail,
    summary,
    diffCount,
    changedFindings,
    baselineComparisonSkipped,
    firstRelease,
    recommendation.label === "likely safe",
  );
  // An AI finding above what the reviewer's own verdict lets it add is shown,
  // but it does not lead the list, drive "Inspect … findings" or fill the
  // severity bar: a "likely safe" page must not open on a red AI row.
  const severityCounts = countSeverities(
    detail.findings.filter((finding) => !heldByVerdict(finding, ai)),
  );
  const findingTotal = Object.values(severityCounts).reduce((sum, count) => sum + (count ?? 0), 0);
  const releaseFindingIds = new Set(changedFindings.map((finding) => finding.id));
  const manifest = summary.packageJsonDiff;

  return {
    recommendation,
    artifactRisk,
    releaseRisk,
    evidence,
    findingGroups: groupReleaseFindings(changedFindings, ai),
    releaseChanges: buildReleaseChanges(summary, firstRelease),
    severityCounts,
    findingTotal,
    severityIncludesContext: detail.findings.some((finding) => !releaseFindingIds.has(finding.id)),
    validity: artifactValidityCaveats(detail, summary),
    hasSignals:
      baselineComparisonSkipped ||
      // Nothing to compare against is itself the thing to read about.
      firstRelease ||
      releaseFindingCount > 0 ||
      Boolean(manifest?.scripts.length) ||
      Boolean(manifest?.dependencies.length) ||
      (!firstRelease && Boolean(manifest?.entrypointsChanged)),
  };
}

interface ArtifactValidityCaveat {
  key: "digest-mismatch" | "metadata-mismatch";
  text: string;
  /** Labelled claimed-versus-inspected identities, when the record has them. */
  identities?: Array<{ label: string; value: string }>;
}

function gateOutcomeFor(
  gateStatus: string | null,
  decision: string | null | undefined,
): GateOutcome | null {
  if (gateStatus === "approved") return "approved";
  if (gateStatus === "rejected") return decision === "no_publish" ? "rejected" : "rejected-other";
  if (decision === "publish") return "package-approved";
  if (decision === "no_publish") return "package-rejected";
  return null;
}

function artifactValidityCaveats(
  detail: PersistedScanDetail,
  summary: PersistedSummary,
): ArtifactValidityCaveat[] {
  const caveats: ArtifactValidityCaveat[] = [];
  const integrity = parseStagedArtifactIntegrity(summary.stagedPublish?.artifactIntegrity);
  const findingRules = new Set(detail.findings.map((finding) => finding.ruleId));
  if (
    integrity?.status === "mismatch" ||
    findingRules.has(DETERMINISTIC_RULE_IDS.stageTarballDigestMismatch)
  ) {
    caveats.push({
      key: "digest-mismatch",
      text: "The downloaded artifact does not match npm's stage record, so this review describes different bytes.",
    });
  }
  if (findingRules.has(DETERMINISTIC_RULE_IDS.stageMetadataMismatch)) {
    // npm's stage record is the claim; the scan row's name and version were
    // replaced with the inspected tarball manifest after the review.
    const claimed = packageIdentity(
      summary.stagedPublish?.packageName,
      summary.stagedPublish?.version,
    );
    const inspected = packageIdentity(detail.scan.packageName, detail.scan.stagedVersion);
    caveats.push({
      key: "metadata-mismatch",
      text: "npm's stage record and the inspected tarball name different releases.",
      identities:
        claimed && inspected
          ? [
              { label: "npm stage claims", value: claimed },
              { label: "tarball inspected", value: inspected },
            ]
          : undefined,
    });
  }
  return caveats;
}

function packageIdentity(name: unknown, version: unknown): string | null {
  if (typeof name !== "string" || !name) return null;
  return typeof version === "string" && version ? `${name}@${version}` : name;
}

/**
 * The verdict line the page opens on, above the diff: Drydock's reading on the
 * left, the maintainer's decision on the right.
 *
 * The headline is the recommendation; the risk grade and any assistant note
 * qualify it in one plain caption. Only "manual review" keeps a Badge, because
 * it is the one qualifier that asks the reader to do something. The comparison
 * picker is the diff's control, so it sits on the workbench, not here. The
 * evidence behind the verdict moves below the workbench into the review notes,
 * because a reviewer reads the diff first and the reasoning second.
 */
export function ReleaseVerdictStrip({
  verdict,
  ai,
  decision,
  onShowVerification,
}: {
  verdict: ReleaseVerdict;
  ai: DisplayedAiResult | null;
  decision?: ComponentChildren;
  /** Moves the reader to the section holding the authoritative digests. */
  onShowVerification?: () => void;
}) {
  const { recommendation, artifactRisk, releaseRisk, validity } = verdict;
  const assistant = ai?.model != null ? ai : null;
  return (
    <section class="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      {/* The caveats share the verdict's column so no control sits between a
          label and the line that qualifies it, on any width. */}
      <div class="flex flex-col gap-1.5 min-w-0">
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 min-w-0">
          <h2
            class={`m-0 text-lg font-semibold tracking-[-0.01em] ${verdictTextClass(recommendation.tone)}`}
          >
            {capitalize(recommendation.label)}
          </h2>
          <MonoDetail
            parts={[
              `release risk ${releaseRisk}`,
              artifactRisk !== releaseRisk ? `artifact risk ${artifactRisk}` : null,
              // The model reports the assessment and the manual-review flag
              // independently, so a suspicious assessment without the flag must
              // still surface here; only the clean reading stays quiet.
              assistant?.kind === "complete" && assistant.releaseAssessment !== "nothing_unusual"
                ? `assistant: ${assistant.releaseAssessment.replaceAll("_", " ")}`
                : null,
              assistant?.kind === "unavailable" ? "assistant unavailable" : null,
            ]}
          />
          {assistant?.kind === "complete" && assistant.requiresManualReview ? (
            <Badge tone="medium" class="self-center">
              manual review
            </Badge>
          ) : null}
        </div>
        {recommendation.caveat ? (
          <p
            class={`m-0 text-[13px] leading-[1.55] ${verdictTextClass(recommendation.caveat.tone)}`}
          >
            {recommendation.caveat.text}
          </p>
        ) : null}
        {validity.map((caveat) => (
          <div key={caveat.key} class="flex flex-col gap-1 text-[13px] leading-[1.55] min-w-0">
            <p class="m-0 flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span class="text-danger-text">{caveat.text}</span>
              {caveat.key === "digest-mismatch" && onShowVerification ? (
                <button type="button" onClick={onShowVerification} class={TEXT_ACTION}>
                  View artifact verification
                </button>
              ) : null}
            </p>
            {caveat.identities ? (
              <dl class="m-0 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-ink-subtle">
                {caveat.identities.map((identity) => (
                  <div key={identity.label} class="flex flex-wrap gap-x-2 min-w-0">
                    <dt>{identity.label}</dt>
                    <dd class="m-0 text-ink-muted break-all">{identity.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        ))}
      </div>
      {decision}
    </section>
  );
}

/** Why the verdict reads the way it does. Lives in the review notes group. */
export function ReleaseVerdictEvidence({
  verdict,
  onSelectFinding,
  onInspectFindings,
  consistencyNote,
  canInspectFinding,
}: {
  verdict: ReleaseVerdict;
  onSelectFinding?: (finding: ReviewFinding) => void;
  onInspectFindings?: () => void;
  consistencyNote?: ComponentChildren;
  canInspectFinding?: (finding: ReviewFinding) => boolean;
}) {
  const { recommendation, evidence, findingGroups, severityCounts, findingTotal } = verdict;
  const firstFinding = findingGroups.find((group) => !group.heldBy)?.findings[0];
  const inspect =
    firstFinding &&
    canSelectFinding(firstFinding) &&
    (canInspectFinding?.(firstFinding) ?? true) &&
    onSelectFinding
      ? () => onSelectFinding(firstFinding)
      : onInspectFindings;
  return (
    <section class="flex flex-col gap-4">
      <SectionLabel as="h3">Why this verdict</SectionLabel>
      {/* The inspect action is a text link like "View manifest changes": the
          page's one filled button is Decide, and a second one here competed
          with it for the same glance. */}
      <div class="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        {recommendation.copy ? (
          <p class="m-0 max-w-[680px] text-[14px] leading-[1.55] text-ink">{recommendation.copy}</p>
        ) : null}
        {firstFinding && inspect ? (
          <button type="button" onClick={inspect} class={TEXT_ACTION}>
            Inspect {firstFinding.severity} findings
          </button>
        ) : null}
      </div>
      {evidence.length ? (
        <ul class="list-none p-0 m-0 flex flex-col gap-2 max-w-[680px]">
          {evidence.map((item, index) => (
            <li key={`${item.label}-${index}`} class="text-[13px] leading-[1.55] text-ink-muted">
              {item.value}
            </li>
          ))}
        </ul>
      ) : null}
      {findingGroups.length ? (
        <ul class="list-none p-0 m-0 divide-y divide-border">
          {findingGroups.map((group) => (
            <ReleaseFindingGroupRow
              key={group.key}
              group={group}
              onSelectFinding={onSelectFinding}
              canInspectFinding={canInspectFinding}
            />
          ))}
        </ul>
      ) : null}
      {/* A lone finding is already stated by its inline annotation and its
          row above; a one-segment bar plus its legend and total would state
          it three more times. */}
      {findingTotal > 1 ? (
        <SeverityBar
          counts={severityCounts}
          // The rows above list release changes only; the bar also counts
          // package context, so it must not read as the release's total.
          label={verdict.severityIncludesContext ? "all package findings by severity" : undefined}
          class="max-w-[520px]"
        />
      ) : null}
      {consistencyNote ? <div class="max-w-[680px]">{consistencyNote}</div> : null}
    </section>
  );
}

interface ReleaseFindingGroup {
  key: string;
  findings: ReviewFinding[];
  /** Set on AI findings the reviewer's own verdict keeps below their severity. */
  heldBy?: { assessment: string; cap: string };
}

type CompleteAiResult = Extract<DisplayedAiResult, { kind: "complete" }>;

const SEVERITY_RANK: Record<string, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

function heldByVerdict(
  finding: Pick<ReviewFinding, "source" | "severity">,
  ai: DisplayedAiResult | null,
): CompleteAiResult | null {
  if (finding.source !== "ai" || ai?.kind !== "complete") return null;
  const cap = aiVerdictRiskCap(ai.releaseAssessment);
  return (SEVERITY_RANK[finding.severity] ?? 0) > (SEVERITY_RANK[cap] ?? 0) ? ai : null;
}

export function groupReleaseFindings(
  findings: ReviewFinding[],
  ai: DisplayedAiResult | null = null,
): ReleaseFindingGroup[] {
  const groups = new Map<string, ReleaseFindingGroup>();
  const held = findings.filter((finding) => heldByVerdict(finding, ai));
  const counted = findings.filter((finding) => !heldByVerdict(finding, ai));
  for (const finding of [...sortFindingsBySeverity(counted), ...sortFindingsBySeverity(held)]) {
    // A shared rule identity does not make AI evidence deterministic, or make
    // occurrences with different severity equivalent. Unknown rules stay separate.
    const key = JSON.stringify(
      finding.ruleId ? [finding.ruleId, finding.severity, finding.source] : [null, finding.id],
    );
    const group = groups.get(key);
    const heldAi = heldByVerdict(finding, ai);
    if (group) group.findings.push(finding);
    else {
      groups.set(key, {
        key,
        findings: [finding],
        ...(heldAi
          ? {
              heldBy: {
                assessment: heldAi.releaseAssessment.replaceAll("_", " "),
                cap: aiVerdictRiskCap(heldAi.releaseAssessment),
              },
            }
          : {}),
      });
    }
  }
  return [...groups.values()];
}

function canSelectFinding(finding: ReviewFinding): boolean {
  return finding.source !== "ai" && finding.file !== RELEASE_PROCESS_FINDING_FILE;
}

function ReleaseFindingGroupRow({
  group,
  onSelectFinding,
  canInspectFinding,
}: {
  group: ReleaseFindingGroup;
  onSelectFinding?: (finding: ReviewFinding) => void;
  canInspectFinding?: (finding: ReviewFinding) => boolean;
}) {
  const first = group.findings[0];
  const title = first.ruleId
    ? capitalize(
        first.ruleId
          .replace(/^(?:code|file)\./, "")
          .replaceAll(".", " ")
          .replaceAll("-", " "),
      )
    : "Finding";
  const sharedReason = group.findings.every((finding) => finding.reason === first.reason);
  return (
    <li class="py-3 first:pt-0 last:pb-0 min-w-0">
      <details class="group">
        <summary class="cursor-pointer text-[13px] text-ink marker:text-ink-subtle">
          <span class="inline-flex flex-wrap items-center gap-x-2 gap-y-1 align-middle">
            <Badge tone={group.heldBy ? "neutral" : severityTone(first.severity)}>
              {first.severity}
            </Badge>
            <span class="font-medium">{title}</span>
            <span class="text-ink-muted">
              · {group.findings.length} {pluralize("location", group.findings.length)}
            </span>
            {first.source === "ai" ? <Badge tone="neutral">AI · advisory</Badge> : null}
          </span>
          {/* Inside the summary so the explanation stays under its title
              whether the locations are folded or not. */}
          {sharedReason ? (
            <span class="block mt-2 max-w-[680px] leading-[1.55] text-ink-muted">
              {findingSentence(first.reason)}
            </span>
          ) : null}
        </summary>
        <div class="pt-3 pl-4 flex flex-col gap-3">
          {first.ruleId ? (
            <code class="text-[11px] text-ink-subtle break-all">{first.ruleId}</code>
          ) : null}
          <ul class="list-none p-0 m-0 flex flex-col gap-3">
            {group.findings.map((finding) => (
              <li key={finding.id} class="flex flex-col gap-1 min-w-0">
                {onSelectFinding &&
                canSelectFinding(finding) &&
                (canInspectFinding?.(finding) ?? true) ? (
                  <button
                    type="button"
                    onClick={() => onSelectFinding(finding)}
                    class="text-left font-mono text-[13px] text-accent hover:underline break-all cursor-pointer bg-transparent border-0 p-0"
                    title={`Inspect ${finding.file}${finding.line ? ` at line ${finding.line}` : ""}`}
                  >
                    {finding.file}
                    {finding.line ? `:${finding.line}` : ""}
                  </button>
                ) : (
                  <code class="text-[13px] text-ink-muted break-all">
                    {finding.file}
                    {finding.line ? `:${finding.line}` : ""}
                  </code>
                )}
                {!sharedReason ? (
                  <p class="m-0 max-w-[680px] text-[13px] leading-[1.55] text-ink-muted">
                    {findingSentence(finding.reason)}
                  </p>
                ) : null}
                <code class="block max-w-[680px] text-[12px] leading-[1.55] text-ink-muted break-all whitespace-pre-wrap">
                  {finding.evidence}
                </code>
              </li>
            ))}
          </ul>
        </div>
      </details>
      {group.heldBy ? (
        <p class="m-0 mt-1 max-w-[680px] text-[13px] leading-[1.55] text-ink-muted">
          {group.heldBy.cap === "low"
            ? `Adds nothing to the risk: the reviewer's own verdict was ${group.heldBy.assessment}.`
            : `Counts as ${group.heldBy.cap} at most: the reviewer's own verdict was ${group.heldBy.assessment}.`}
        </p>
      ) : null}
    </li>
  );
}

export function ReleaseChangesSummary({
  verdict,
  onInspectChanges,
}: {
  verdict: ReleaseVerdict;
  onInspectChanges?: () => void;
}) {
  if (!verdict.releaseChanges.length) return null;
  return (
    <section class="flex flex-col gap-2">
      <SectionLabel as="h3">Release changes</SectionLabel>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
        <p class="m-0 text-ink-muted">{verdict.releaseChanges.join(" · ")}</p>
        {onInspectChanges ? (
          <button type="button" onClick={onInspectChanges} class={TEXT_ACTION}>
            View manifest changes
          </button>
        ) : null}
      </div>
    </section>
  );
}

const TEXT_ACTION =
  "p-0 border-0 bg-transparent text-[13px] text-accent hover:underline cursor-pointer text-left";

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// The verdict heading carries severity meaning, so it uses the `-text` severity
// variants (text role), never the saturated tokens. Neutral verdicts stay --ink.

function buildRecommendationEvidence(
  detail: PersistedScanDetail,
  summary: PersistedSummary,
  diffCount: number,
  changedFindings: ReviewFinding[],
  baselineComparisonSkipped: boolean,
  firstRelease: boolean,
  verdictSaysClean: boolean,
): Array<{ label: string; value: ComponentChildren }> {
  const evidence: Array<{ label: string; value: ComponentChildren }> = [];
  // Lead with the missing comparison: it explains why there are no release
  // deltas below, which would otherwise read as an all-clear.
  if (baselineComparisonSkipped) {
    const version = summary.baseline?.version;
    evidence.push({
      label: "baseline",
      value: version
        ? `Published ${version} exceeded the download budget, so no file was compared against it.`
        : "The published release exceeded the download budget, so no file was compared against it.",
    });
  }
  if (evidence.length === 0 && changedFindings.length === 0) {
    const changed =
      diffCount ||
      summary.diff?.filter((entry) => entry.status !== "unchanged").length ||
      detail.files.filter((file) => file.status !== "unchanged").length;
    if (firstRelease) {
      // The verdict copy already says there is nothing to compare against;
      // the count is the only new fact.
      evidence.push({
        label: "evidence",
        value: `${changed} ${pluralize("file", changed)}, all new.`,
      });
      return evidence;
    }
    const files = `${changed} changed ${pluralize("file", changed)}`;
    const packageNote = detail.findings.length ? " Package findings remain below." : "";
    evidence.push({
      label: "evidence",
      // "Likely safe" already says nothing fired on the release delta; the
      // other verdicts (package context only) still need it said.
      value: verdictSaysClean
        ? `${files}.${packageNote}`
        : `${files}; no findings in this release delta.${packageNote}`,
    });
  }

  return evidence;
}

function buildReleaseChanges(summary: PersistedSummary, firstRelease: boolean): string[] {
  const changes: string[] = [];
  const manifest = summary.packageJsonDiff;
  if (manifest?.scripts.length)
    changes.push(
      `${manifest.scripts.length} lifecycle or package script ${pluralize("change", manifest.scripts.length)}`,
    );
  if (manifest?.dependencies.length)
    changes.push(
      `${manifest.dependencies.length} dependency ${pluralize("change", manifest.dependencies.length)}`,
    );
  // With no earlier manifest every entrypoint is "changed", which says nothing.
  if (manifest?.entrypointsChanged && !firstRelease) changes.push("Package entrypoints changed");
  return changes;
}
