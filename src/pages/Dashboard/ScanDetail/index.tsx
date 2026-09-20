import { useModel } from "@preact/signals";
import { useRoute } from "preact-iso";
import { ScanDetailModel, type ScanDetailModelInstance } from "../../../models/scan";
import { badgeEcosystem, scanDistTag } from "../../../../server/lib/public-feed";
import { useAuthedDashboardSession } from "../../../features/account/useAuthedDashboardSession";
import { ReviewWorkbench } from "../../../features/review/ReviewWorkbench";
import { RiskSignalsSection } from "../../../features/review/RiskSignalsSection";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { CollapsibleCard } from "../../../components/Card";
import { LoadingState } from "../../../components/Loading";
import { PageShell } from "../../../components/PageShell";
import { LoadingLine } from "../../../components/Typography";
import { VersionPicker } from "../../../components/VersionPicker";
import { DeleteScanDialog } from "./DeleteScanDialog";
import { DecisionDialog } from "./DecisionDialog";
import { GateContextPanel, GateDecisionDialog, GatePackagesPanel } from "./GateDecisionDialog";
import { StageCommandDialogHost } from "./StageCommandDialog";
import { DiffWorkbench } from "./DiffWorkbench";
import { IntentEnvelopeSection } from "./IntentEnvelopeSection";
import { RegistryStatusNotice } from "./RegistryStatusNotice";
import { ReleaseConsistencyNotice } from "./ReleaseConsistencyNotice";
import {
  ReleaseChangesSummary,
  ReleaseVerdictEvidence,
  ReleaseVerdictStrip,
} from "./ReleaseRecommendation";
import { ReleaseTimeline } from "./ReleaseTimeline";
import { PersistedReportSections } from "./ReportSections";
import { ReviewerSummary } from "./ReviewerSummary";
import { ScanDetailHeader, ScanFailureAlert, VersionPickerSkeleton } from "./ScanDetailChrome";
import { ShareDialog } from "./ShareDialog";
import {
  focusReportSection,
  useScanDetailView,
  type ScanDetailView,
} from "./hooks/useScanDetailView";

/**
 * The page is split into sections that each read the model signals they
 * render. `ScanReport` holds the risk index (one card per finding, thousands
 * for a large package), so anything that changes at keystroke or round-trip
 * rate — the tree filter, a dialog's save status, the selected file's body —
 * is read by a narrower component or by the dialog itself.
 */
export default function ScanDetailPage() {
  const route = useRoute();
  const id = route.params.id;
  const model = useModel(() => new ScanDetailModel(id));
  const sessionChecked = useAuthedDashboardSession({
    onReady: () => model.load(),
    deps: [id],
    rememberReturnUrl: false,
  });
  const view = useScanDetailView(model);

  if (!sessionChecked.value) {
    return (
      <PageShell>
        <ScanDetailHeader />
        <LoadingState title="Opening review" detail="confirming session · fetching report" />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <ScanHeader model={model} view={view} />
      <ScanNotices model={model} view={view} />
      <ScanReport model={model} view={view} />
      <ScanDialogs model={model} view={view} />
    </PageShell>
  );
}

type SectionProps = { model: ScanDetailModelInstance; view: ScanDetailView };

function ScanHeader({ model, view }: SectionProps) {
  const detail = model.detail.value;
  // The decision button rides the verdict strip on a completed review, beside
  // the comparison it is a decision about. A failed gate review renders no
  // strip, so there it stays the header action.
  const headerDecideClick =
    detail?.scan.status === "complete" ? undefined : view.decideAction.value;
  return (
    <ScanDetailHeader
      detail={detail}
      onDecideClick={headerDecideClick}
      onDeleteClick={view.deleteAction.value}
      onShareClick={view.shareAction.value}
      shareSignal={model.share}
    />
  );
}

function ScanNotices({ model, view }: SectionProps) {
  const detail = model.detail.value;
  const error = model.error.value;
  const pollingStalled = model.pollingStalled.value;
  const isWorkflowGate = model.isWorkflowGate.value;
  const gate = model.gate.value;
  return (
    <>
      {error ? <Alert tone="critical">{error}</Alert> : null}
      {pollingStalled ? (
        <Alert tone="warn">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <span>Automatic refresh stopped after 10 minutes without the review finishing.</span>
            <Button variant="secondary" size="sm" onClick={() => model.resumePolling()}>
              Resume refresh
            </Button>
          </div>
        </Alert>
      ) : null}
      {isWorkflowGate && detail ? (
        <GateContextPanel
          gate={gate}
          packageName={detail.scan.packageName}
          canRetry={
            gate?.status === "pending" && view.gateReviewFailed.value && !detail.scan.decision
          }
          retryStatus={model.gateRetryStatus.value}
          retryError={model.gateRetryError.value}
          onRetry={view.handleGateRetry}
        />
      ) : null}
      {isWorkflowGate && detail && gate ? (
        <GatePackagesPanel
          gate={gate}
          currentScanId={detail.scan.id}
          onDecide={view.decideAction.value}
        />
      ) : null}
      {detail?.scan.status === "failed" ? (
        <ScanFailureAlert errorJson={detail.scan.errorJson} />
      ) : null}

      {/* Above the verdict on purpose: npm blocking a version, or still
          holding one this organization already approved, outranks anything the
          report has to say about it. Rendered for failed scans too — a review
          that could not read the tarball is exactly when npm's own state is
          the only useful thing on the page. */}
      {detail ? <RegistryStatusNotice scan={detail.scan} /> : null}

      {!detail && !error ? (
        <LoadingState title="Loading saved review" detail="fetching report · normalizing diff" />
      ) : null}
    </>
  );
}

function ScanReport({ model, view }: SectionProps) {
  const detail = model.detail.value;
  const verdict = view.verdict.value;
  const summary = view.summary.value;
  const ai = view.ai.value;
  const envelope = view.intentEnvelope.value;
  const findingsWithDiffStatus = view.findingsWithDiffStatus.value;
  const pollingStalled = model.pollingStalled.value;
  if (!detail) return null;
  const hasRuleFindings = Boolean(detail.findings.length);

  return (
    <>
      {detail.scan.status === "complete" && verdict ? (
        <>
          {/* Verdict, comparison, and the decision — one strip, then the
              diff. Everything explaining the verdict moves below the
              workbench: a reviewer reads the change first. */}
          <ReleaseVerdictStrip
            verdict={verdict}
            ai={ai}
            comparison={
              detail.scan.packageName ? <VerdictComparison model={model} view={view} /> : null
            }
            decision={
              view.decideAction.value ? <VerdictDecision model={model} view={view} /> : null
            }
          />
          <CompareStatus model={model} />

          <ReviewWorkbench
            id="release-workbench"
            entries={view.diffEntries}
            fileFilter={view.fileFilter}
            changedFilesOnly={view.changedFilesOnly}
            selectedPath={model.selectedPath}
            findingCounts={view.findingCounts}
            onSelect={(path) => {
              view.findingTarget.value = null;
              model.selectPath(path);
            }}
          >
            <ScanDiffPanel model={model} view={view} />
          </ReviewWorkbench>

          <CollapsibleCard title="Review notes" defaultOpen={view.reviewNotesOpen.value}>
            <div class="px-5 pb-5 pt-4 flex flex-col gap-5">
              <ReleaseVerdictEvidence
                verdict={verdict}
                onSelectFinding={view.inspectFinding}
                canInspectFinding={view.canInspectFinding}
                onInspectFindings={view.inspectFindings}
                consistencyNote={
                  <ReleaseConsistencyNotice
                    value={summary.releaseConsistency}
                    approvedContextCount={detail.riskSummary?.priorApprovedContextFindingCount ?? 0}
                  />
                }
              />
              <ReleaseChangesSummary
                verdict={verdict}
                onInspectChanges={() => focusReportSection("manifest-changes")}
              />
              <ReviewerSummary
                ai={ai}
                findings={detail.findings}
                onInspectFindings={view.inspectFindings}
              />
              {envelope ? <IntentEnvelopeSection envelope={envelope} /> : null}
            </div>
          </CollapsibleCard>

          {hasRuleFindings ? (
            <RiskSignalsSection
              id="risk-signals"
              findings={findingsWithDiffStatus}
              onSelect={(file) => view.inspectFile(file)}
            />
          ) : null}

          <PersistedReportSections summary={summary} />
        </>
      ) : detail.scan.status === "pending" || detail.scan.status === "running" ? (
        // While stalled the pulsing line would falsely promise an
        // auto-refresh; the warn Alert above carries the state instead.
        pollingStalled ? null : (
          <LoadingState
            title={detail.scan.status === "pending" ? "Review queued" : "Reviewing release"}
            detail="auto-refreshes when the report is ready"
          />
        )
      ) : null}

      {/* Below the report on purpose: pipeline latency is supporting context,
          not the verdict. Rendered for every status so a failed or queued
          review still shows how far the release got. */}
      <ReleaseTimeline scan={detail.scan} summary={summary} />
    </>
  );
}

// The version picker and decision button, read apart from the report so a
// comparison fetch does not re-render the risk index.
function VerdictComparison({ model, view }: SectionProps) {
  const detail = model.detail.value;
  const versions = view.versions.value;
  if (!detail) return null;
  return versions ? (
    <VersionPicker
      options={versions.versions}
      selected={model.selectedVersion.value}
      defaultVersion={versions.defaultPreviousVersion}
      stagedVersion={versions.stagedVersion}
      onChange={(value) => model.selectVersion(value)}
      disabled={model.compareLoading.value}
    />
  ) : (
    <VersionPickerSkeleton stagedVersion={detail.scan.stagedVersion ?? null} />
  );
}

function VerdictDecision({ model, view }: SectionProps) {
  const detail = model.detail.value;
  const decide = view.decideAction.value;
  if (!detail || !decide) return null;
  return (
    <Button variant={detail.scan.decision ? "secondary" : "primary"} onClick={decide}>
      {detail.scan.decision ? "Update decision" : "Decide"}
    </Button>
  );
}

function CompareStatus({ model }: { model: ScanDetailModelInstance }) {
  const compareLoading = model.compareLoading.value;
  const compareError = model.compareError.value;
  return (
    <>
      {compareLoading ? (
        <LoadingLine size="inline">Fetching {model.selectedVersion.value} via sandbox</LoadingLine>
      ) : null}
      {compareError ? <Alert tone="warn">{compareError}</Alert> : null}
    </>
  );
}

// Selecting a file swaps its body in here and nowhere else.
function ScanDiffPanel({ model, view }: SectionProps) {
  return (
    <DiffWorkbench
      entry={view.selectedEntry.value}
      stagedMeta={view.stagedFileMeta.value}
      staged={view.stagedFile.value}
      previousMeta={view.previousFileMeta.value}
      previousContent={view.previousFile.value}
      compareReady={Boolean(model.compare.value)}
      compareLoading={model.compareLoading.value}
      selectedVersion={model.selectedVersion.value}
      stagedVersion={model.detail.value?.scan.stagedVersion ?? null}
      findings={view.selectedFindings.value}
      findingTarget={
        view.findingTarget.value?.file === model.selectedPath.value
          ? view.findingTarget.value
          : null
      }
    />
  );
}

// The dialogs read their own open/status/error signals, so mounting them here
// costs this section a subscription to `detail` and nothing more.
function ScanDialogs({ model, view }: SectionProps) {
  const detail = model.detail.value;
  const isWorkflowGate = model.isWorkflowGate.value;
  const gate = model.gate.value;
  const completeAndCurrent =
    detail?.scan.status === "complete" && detail.scan.registryStatusSupersededAt == null;
  return (
    <>
      {detail && completeAndCurrent && !isWorkflowGate ? (
        <DecisionDialog
          open={view.decisionDialogOpen}
          onClose={() => (view.decisionDialogOpen.value = false)}
          decision={detail.scan.decision}
          decisionReason={detail.scan.decisionReason}
          decidedAt={detail.scan.decidedAt}
          status={model.decisionStatus}
          error={model.decisionError}
          npmStagedPackagesUrl={view.npmStagedPackagesUrl}
          scan={detail.scan}
          onSubmit={view.handleDecisionSubmit}
        />
      ) : null}

      {detail && completeAndCurrent ? (
        <ShareDialog
          open={view.shareDialogOpen}
          onClose={() => (view.shareDialogOpen.value = false)}
          share={model.share}
          status={model.shareStatus}
          error={model.shareError}
          attestationAvailable={model.attestationAvailable}
          badgeEcosystem={badgeEcosystem(detail.scan.source ?? "", detail.scan.summaryJson)}
          packageName={detail.scan.packageName}
          badgeTag={scanDistTag(detail.scan.summaryJson)}
          onEnable={() => void model.enableShare()}
          onRevoke={() => void model.revokeShare()}
          onSetFeedListing={(listed) => void model.setFeedListing(listed)}
        />
      ) : null}

      {detail && isWorkflowGate && gate ? (
        <GateDecisionDialog
          open={view.gateDialogOpen}
          onClose={() => (view.gateDialogOpen.value = false)}
          gate={gate}
          packageName={detail.scan.packageName}
          status={model.gateDecisionStatus}
          error={model.gateDecisionError}
          requireTwoFactor={view.requireTwoFactor}
          packageDecision={
            detail.scan.decision === "publish" || detail.scan.decision === "no_publish"
              ? detail.scan.decision
              : null
          }
          canApprove={
            Boolean(gate.scanId) &&
            (detail.scan.status === "complete" || detail.scan.status === "failed")
          }
          reviewFailed={detail.scan.status === "failed"}
          onSubmit={view.handleGateDecision}
        />
      ) : null}

      <StageCommandDialogHost />

      {detail?.scan.status === "failed" ? (
        <DeleteScanDialog
          open={view.deleteDialogOpen}
          onClose={() => (view.deleteDialogOpen.value = false)}
          packageName={detail.scan.packageName}
          status={model.deleteStatus}
          error={model.deleteError}
          onConfirm={view.handleDelete}
        />
      ) : null}
    </>
  );
}
