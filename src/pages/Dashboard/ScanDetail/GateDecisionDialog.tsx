import { useEffect } from "preact/hooks";
import { useSignal } from "@preact/signals";
import type { DecisionStatus } from "../../../models/scan";
import { scanDetailPath } from "../../../lib/scan-detail-path";
import {
  GATE_STALE_REVIEW_MESSAGES,
  type GatePackageDecision,
  type GatePackageScan,
  type PublicWorkflowGate,
  type WorkflowGateDecision,
  gateReviewIsStale,
} from "../../../models/github-app";
import { Alert } from "../../../components/Alert";
import { Badge, severityTone } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { readSignalProp, type SignalOrValue } from "../../../components/signal-props";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { LoadingLine, MonoDetail, Muted, SectionLabel } from "../../../components/Typography";
import { verdictTextClass } from "../../../features/review/verdict";
import type { ReleaseRecommendationCopy } from "../recommendation";

function gateStatusTone(status: PublicWorkflowGate["status"]) {
  switch (status) {
    case "approved":
      return "ok" as const;
    case "rejected":
    case "errored":
      return "critical" as const;
    default:
      return "medium" as const;
  }
}

function gateStatusLabel(status: PublicWorkflowGate["status"]): string {
  switch (status) {
    case "approved":
      return "approved · job released";
    case "rejected":
      return "rejected · job blocked";
    case "errored":
      return "review errored";
    case "superseded":
      return "superseded · newer request";
    default:
      return "awaiting decision";
  }
}

// Only a package that blocks the release gets a colored chip. Approved,
// reviewing, and awaiting-decision are the expected states of a roster row and
// read as plain text, so the one row holding the release up stands out. A
// failed review holds it up only until someone decides: approving the package
// anyway is allowed, and that row then reads "approved", not an alarm.
export function packageDecisionNeedsAttention(
  pkg: Pick<GatePackageScan, "decision" | "status">,
): boolean {
  return pkg.decision === "no_publish" || (!pkg.decision && pkg.status === "failed");
}

function packageDecisionLabel(pkg: GatePackageScan): string {
  if (pkg.decision === "publish") return "approved";
  if (pkg.decision === "no_publish") return "rejected";
  if (pkg.status === "failed") return "review failed";
  if (pkg.status !== "complete") return "reviewing";
  return "awaiting decision";
}

function packageLabel(pkg: GatePackageScan): string {
  if (pkg.packageName && pkg.version) return `${pkg.packageName}@${pkg.version}`;
  return pkg.packageName ?? "package";
}

/**
 * Roster of every package the gated release publishes. A monorepo fans the gate
 * out into one scan per package and the held deployment only releases once all
 * of them are approved — so this panel makes the sibling packages and their
 * per-package decision state visible from any one package's review page, with a
 * link to open each sibling's own review. The current package's row shows its
 * state only: the verdict strip's Decide button is the one way to decide it.
 * The all-packages rule is stated by the gate card and the decision dialog.
 *
 * Renders nothing for a single-package gate, where the roster would just echo
 * the page you're already on.
 */
export function GatePackagesPanel({
  gate,
  currentScanId,
  organizationId,
}: {
  gate: PublicWorkflowGate;
  currentScanId: string;
  /** A gate's package reviews all belong to the gate's organization. */
  organizationId?: string | null;
}) {
  const packages = gate.packages;
  if (packages.length <= 1) return null;
  const approved = packages.filter((pkg) => pkg.decision === "publish").length;
  const rejected = packages.filter((pkg) => pkg.decision === "no_publish").length;
  const pending = gate.status === "pending";

  return (
    <section class="flex flex-col gap-3 border border-border rounded-lg p-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel as="h2">Release packages</SectionLabel>
        <span class="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-subtle">
          {approved} of {packages.length} approved
          {rejected ? ` · ${rejected} rejected` : ""}
        </span>
      </div>
      <ul class="m-0 p-0 list-none flex flex-col">
        {packages.map((pkg) => {
          const isCurrent = pkg.scanId === currentScanId;
          return (
            <li
              key={pkg.scanId}
              class="border-t border-border first:border-t-0 py-2.5 flex flex-wrap items-center justify-between gap-2"
            >
              <div class="flex items-center gap-2 flex-wrap min-w-0">
                <span class="font-mono text-[13px] font-medium truncate">{packageLabel(pkg)}</span>
                {pkg.releaseRisk ? (
                  <Badge tone={severityTone(pkg.releaseRisk)}>{pkg.releaseRisk}</Badge>
                ) : null}
                {isCurrent ? (
                  <span class="font-mono text-[11px] text-ink-subtle">this package</span>
                ) : null}
              </div>
              <div class="flex items-center gap-3 shrink-0">
                {packageDecisionNeedsAttention(pkg) ? (
                  <Badge tone="critical">{packageDecisionLabel(pkg)}</Badge>
                ) : (
                  <span class="font-mono text-[11px] text-ink-muted">
                    {packageDecisionLabel(pkg)}
                  </span>
                )}
                {isCurrent ? null : (
                  <a
                    class="font-mono text-[11px] underline text-accent"
                    href={scanDetailPath(pkg.scanId, organizationId)}
                  >
                    {pending && !pkg.decision ? "review →" : "open →"}
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * What the held job is doing now, in one sentence beside the status label. Read
 * from the gate state so a decided gate never still claims GitHub is holding
 * the job, and worded so it does not repeat the label.
 */
export function gateJobSentence(
  gate: Pick<PublicWorkflowGate, "status" | "failureReason" | "packages">,
): string | null {
  const count = gate.packages.length;
  switch (gate.status) {
    case "approved":
      return "Drydock told GitHub Actions to continue the publish job.";
    case "rejected":
      return "Drydock told GitHub Actions not to run the protected publish job.";
    case "superseded":
      return "A newer deployment request for this run and Environment replaced this gate; only that one can continue the publish job.";
    case "errored":
      // The failure Alert below names the reason and the consequence.
      return gate.failureReason
        ? null
        : "Drydock could not prepare this gate review, so the publish job cannot continue.";
    default:
      // The stale-review alert below says what changed and what to do.
      if (gateReviewIsStale(gate)) return null;
      return count > 1
        ? `GitHub Actions is holding the publish job until all ${count} release packages are approved; rejecting any one blocks it.`
        : "GitHub Actions is holding the publish job until this release is approved or rejected.";
  }
}

// Waiting on a decision, or a gate that broke, asks something of the reader; a
// decided gate is a record and reads as plain mono text.
function gateStatusNeedsAttention(status: PublicWorkflowGate["status"]): boolean {
  return status === "pending" || status === "errored";
}

export function GateContextPanel({
  gate,
  canRetry,
  retryStatus,
  retryError,
  onRetry,
  lookupStalled,
  onRetryLookup,
}: {
  gate: PublicWorkflowGate | null;
  canRetry?: boolean;
  retryStatus?: DecisionStatus;
  retryError?: string | null;
  onRetry?: () => void;
  lookupStalled?: boolean;
  onRetryLookup?: () => void;
}) {
  const retrying = retryStatus === "saving";
  const sentence = gate ? gateJobSentence(gate) : null;
  return (
    <section class="flex flex-col gap-3 border border-border rounded-lg p-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel as="h2">Deployment gate</SectionLabel>
        {gate ? (
          gateStatusNeedsAttention(gate.status) ? (
            <Badge tone={gateStatusTone(gate.status)}>{gateStatusLabel(gate.status)}</Badge>
          ) : (
            <span class="font-mono text-[11px] text-ink-muted">{gateStatusLabel(gate.status)}</span>
          )
        ) : null}
      </div>
      {sentence ? (
        <p class="m-0 max-w-[760px] text-[14px] leading-[1.55] text-ink-muted">{sentence}</p>
      ) : null}
      {gate ? (
        <MonoDetail
          parts={[
            <span key="repo">{gate.repositoryFullName}</span>,
            <span key="env">env {gate.environment}</span>,
            <span key="run">run #{gate.runId}</span>,
            ...(gate.runAttempt ? [<span key="attempt">attempt {gate.runAttempt}</span>] : []),
          ]}
        />
      ) : lookupStalled ? (
        <Alert tone="warn">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <span>Gate context could not be loaded. Automatic lookup has stopped.</span>
            <Button variant="secondary" size="sm" onClick={onRetryLookup}>
              Retry lookup
            </Button>
          </div>
        </Alert>
      ) : (
        <LoadingLine size="inline">Loading gate context</LoadingLine>
      )}
      {gate && gateReviewIsStale(gate) ? (
        <Alert tone="warn">
          {GATE_STALE_REVIEW_MESSAGES[gate.failureReason ?? ""]} Retry the review to check the run's
          current artifacts, or reject to block the job.
        </Alert>
      ) : gate?.failureReason && gate.status !== "superseded" ? (
        <Alert tone="critical">
          Drydock could not prepare the gate review ({gate.failureReason}); the configured protected
          job cannot continue.
        </Alert>
      ) : null}
      {canRetry && onRetry ? (
        <div class="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={onRetry} disabled={retrying}>
            {retrying ? "Retrying…" : "Retry review"}
          </Button>
          <Muted class="m-0 text-[12px]">
            Re-runs the gate review from the workflow artifacts and replaces the current batch.
          </Muted>
        </div>
      ) : null}
      {retryError ? <Alert tone="critical">{retryError}</Alert> : null}
    </section>
  );
}

export function GateDecisionDialog({
  open,
  onClose,
  gate,
  packageName,
  stagedVersion = null,
  verdict = null,
  packageDecision,
  status,
  error,
  canApprove,
  requireTwoFactor: requireTwoFactorProp,
  reviewFailed,
  onSubmit,
}: {
  // Signals are read inside the dialog so the decision round-trip re-renders
  // it alone, not the review page with its per-finding risk index.
  open: SignalOrValue<boolean>;
  onClose: () => void;
  gate: PublicWorkflowGate;
  packageName: string | null;
  stagedVersion?: string | null;
  /**
   * Drydock's verdict on this package. As in the npm decision dialog it picks
   * the filled action, so a blocked verdict never opens on a filled approve.
   */
  verdict?: SignalOrValue<{
    recommendation: Pick<ReleaseRecommendationCopy, "label" | "tone">;
  } | null>;
  /** This package's recorded decision, if it has already been decided. */
  packageDecision: GatePackageDecision | null;
  status: SignalOrValue<DecisionStatus>;
  error: SignalOrValue<string | null>;
  canApprove: boolean;
  /** Whether this member enrolled in 2FA, which decides if a step-up code is asked for. */
  requireTwoFactor: SignalOrValue<boolean>;
  reviewFailed?: boolean;
  onSubmit: (
    decision: WorkflowGateDecision,
    comment: string | null,
    totpCode: string | null,
  ) => void | Promise<void>;
}) {
  const commentDraft = useSignal("");
  const codeDraft = useSignal("");
  const isOpen = readSignalProp(open);
  const saving = readSignalProp(status) === "saving";
  const message = readSignalProp(error);
  const requireTwoFactor = readSignalProp(requireTwoFactorProp);
  // A superseded gate is closed like a decided one: nothing here can act on it.
  const gateDecided =
    gate.status === "approved" || gate.status === "rejected" || gate.status === "superseded";
  const packageAlreadyDecided = packageDecision !== null;
  const packages = gate.packages;
  const multi = packages.length > 1;
  const approvedCount = packages.filter((pkg) => pkg.decision === "publish").length;
  const needsCode = requireTwoFactor && !gateDecided;
  const code = codeDraft.value.trim();
  const blockedOnCode = needsCode && code.length === 0;
  // The org requires a second factor to decide releases but this member hasn't
  // enrolled — they're blocked until they do. `requireTwoFactor` is the member's
  // own enrollment, so this is exactly the case the route answers with 403
  // `two_factor_enrollment_required`. Decided gates/packages are read-only, so
  // there's nothing to block there.
  const mustEnroll =
    gate.organizationRequiresTwoFactor &&
    !requireTwoFactor &&
    !gateDecided &&
    !packageAlreadyDecided;

  useEffect(() => {
    if (isOpen) {
      commentDraft.value = "";
      codeDraft.value = "";
    }
  }, [isOpen]);

  const submit = (next: WorkflowGateDecision) => {
    if (saving || gateDecided || packageAlreadyDecided || blockedOnCode || mustEnroll) return;
    const trimmed = commentDraft.value.trim();
    void onSubmit(next, trimmed.length ? trimmed : null, needsCode ? code : null);
  };

  const handleClose = () => {
    if (saving) return;
    onClose();
  };

  const recommendation = readSignalProp(verdict)?.recommendation ?? null;
  // An unreviewed package has no verdict to lean on, and a package that cannot
  // be approved has only one way out; both lead with the rejection.
  const leadWithReject =
    !canApprove ||
    reviewFailed ||
    recommendation?.tone === "critical" ||
    recommendation?.tone === "high";
  const subject = packageName
    ? stagedVersion
      ? `${packageName}@${stagedVersion}`
      : packageName
    : null;
  const approveLabel = saving
    ? "Submitting…"
    : reviewFailed
      ? multi
        ? "Approve package anyway"
        : "Approve anyway & continue job"
      : multi
        ? "Approve package"
        : "Approve & continue job";
  const rejectLabel = saving ? "Submitting…" : "Reject & block job";
  const actionDisabled = saving || blockedOnCode || mustEnroll;

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={multi ? "Package decision" : "Release decision"}
      description={
        multi
          ? `The protected GitHub Actions publish job continues only once all ${packages.length} packages are approved (${approvedCount} so far); rejecting this one blocks it. Your workflow publishes with its own registry credentials.`
          : "Approving continues the protected GitHub Actions publish job; rejecting blocks it. Your workflow publishes with its own registry credentials."
      }
    >
      <div class="flex flex-col gap-1">
        {subject || recommendation ? (
          <p class="m-0 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px]">
            {subject ? <span class="font-mono text-ink break-all">{subject}</span> : null}
            {recommendation ? (
              <span class={verdictTextClass(recommendation.tone)}>
                Drydock: {recommendation.label}
              </span>
            ) : null}
          </p>
        ) : null}
        <MonoDetail
          parts={[
            <span key="repo">{gate.repositoryFullName}</span>,
            <span key="env">env {gate.environment}</span>,
            <span key="run">run #{gate.runId}</span>,
          ]}
        />
      </div>
      {gateDecided ? (
        <Badge tone={gateStatusTone(gate.status)} class="self-start">
          {gateStatusLabel(gate.status)}
        </Badge>
      ) : packageDecision ? (
        <Badge tone={packageDecision === "publish" ? "ok" : "critical"} class="self-start">
          this package {packageDecision === "publish" ? "approved" : "rejected"}
        </Badge>
      ) : null}

      {reviewFailed && !gateDecided && !packageAlreadyDecided ? (
        <Alert tone="warn">
          This package review failed. Retry the review, or record a human decision based on the
          release evidence you have inspected.
        </Alert>
      ) : null}

      {mustEnroll ? (
        <Alert tone="warn">
          Your organization requires two-factor authentication to approve or reject this gate.
          Enable it in{" "}
          <a class="underline text-accent" href="/dashboard/account">
            Account
          </a>
          , then reopen this decision.
        </Alert>
      ) : null}

      <Field label="Comment (optional, shown in the GitHub run log)" for="gateComment">
        <Input
          id="gateComment"
          type="text"
          value={commentDraft.value}
          placeholder="e.g. reviewed the changed files and install scripts"
          onInput={(e) => (commentDraft.value = (e.target as HTMLInputElement).value)}
          disabled={saving || gateDecided || packageAlreadyDecided || mustEnroll}
          maxLength={500}
          autoComplete="off"
          spellcheck={false}
        />
      </Field>

      {needsCode ? (
        <Field label="Authentication code" for="gateTotp">
          <Input
            id="gateTotp"
            type="text"
            value={codeDraft.value}
            placeholder="6-digit code"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxLength={8}
            spellcheck={false}
            disabled={saving}
            onInput={(e) => (codeDraft.value = (e.target as HTMLInputElement).value)}
          />
          <Muted class="m-0 mt-1 text-[12px]">
            Enter your authenticator code to approve or reject this protected publish job.
          </Muted>
        </Field>
      ) : null}

      {gate.status === "superseded" ? (
        <Muted class="m-0 text-[13px]">
          Decide the newer gate for this run from its own review.
        </Muted>
      ) : gateDecided ? (
        <Muted class="m-0 text-[13px]">
          GitHub has been notified of this gate's final decision.
        </Muted>
      ) : packageAlreadyDecided ? (
        <Muted class="m-0 text-[13px]">
          This package decision is recorded; the protected publish job stays pending while the
          remaining packages await decisions.
        </Muted>
      ) : (
        // One filled action, chosen like the npm decision dialog: the outcome
        // Drydock advises leads, the other stays available as a secondary.
        <div class="flex flex-wrap items-center gap-2">
          {leadWithReject ? (
            <>
              <Button variant="danger" onClick={() => submit("rejected")} disabled={actionDisabled}>
                {rejectLabel}
              </Button>
              {canApprove ? (
                <Button
                  variant="secondary"
                  onClick={() => submit("approved")}
                  disabled={actionDisabled}
                >
                  {approveLabel}
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <Button onClick={() => submit("approved")} disabled={actionDisabled}>
                {approveLabel}
              </Button>
              <Button
                variant="secondary"
                onClick={() => submit("rejected")}
                disabled={actionDisabled}
              >
                {rejectLabel}
              </Button>
            </>
          )}
          <Button variant="ghost" class="ml-auto" onClick={handleClose} disabled={saving}>
            Cancel
          </Button>
        </div>
      )}
      {gateReviewIsStale(gate) && !packageAlreadyDecided ? (
        <Alert tone="warn">{GATE_STALE_REVIEW_MESSAGES[gate.failureReason ?? ""]}</Alert>
      ) : null}
      {!gateDecided && !canApprove ? (
        <Muted class="m-0 text-[13px]">
          Approval requires a completed review batch. Retry the review or reject to block the held
          GitHub job.
        </Muted>
      ) : null}
      {message ? <Alert tone="critical">{message}</Alert> : null}
    </Dialog>
  );
}
