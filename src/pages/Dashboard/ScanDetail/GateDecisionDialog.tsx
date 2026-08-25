import { useEffect } from "preact/hooks";
import { useSignal } from "@preact/signals";
import type { DecisionStatus, ScanApprovalState } from "../../../models/scan";
import type {
  GatePackageDecision,
  GatePackageScan,
  PublicWorkflowGate,
  WorkflowGateDecision,
} from "../../../models/github-app";
import { Alert } from "../../../components/Alert";
import { Badge, severityTone } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { LoadingLine, MonoDetail, Muted, SectionLabel } from "../../../components/Typography";
import { ApprovalRoster, QuorumUnreachableNotice, isMultiApproval } from "./ApprovalRoster";

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
    default:
      return "awaiting decision";
  }
}

function packageDecisionTone(pkg: GatePackageScan) {
  if (pkg.decision === "publish") return "ok" as const;
  if (pkg.decision === "no_publish") return "critical" as const;
  if (pkg.status === "failed") return "critical" as const;
  if (pkg.status !== "complete") return "neutral" as const;
  return "medium" as const;
}

function packageDecisionLabel(pkg: GatePackageScan, requiredApprovals: number): string {
  if (pkg.decision === "publish") return "approved";
  if (pkg.decision === "no_publish") return "rejected";
  if (pkg.status === "failed") return "review failed";
  if (pkg.status !== "complete") return "reviewing";
  // Approved by someone, still short of the bar — the state that would
  // otherwise read as "nobody has looked at this yet".
  if (requiredApprovals > 1 && pkg.approvalCount > 0) {
    return `${pkg.approvalCount} of ${requiredApprovals} approvals`;
  }
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
 * link to open each sibling's own review and an inline decide action on the row
 * for the package you're currently looking at.
 *
 * Renders nothing for a single-package gate, where the roster would just echo
 * the page you're already on.
 */
export function GatePackagesPanel({
  gate,
  currentScanId,
  onDecide,
}: {
  gate: PublicWorkflowGate;
  currentScanId: string;
  /** Opens the decision dialog for the current package; absent until its review resolves. */
  onDecide?: () => void;
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
      <p class="m-0 max-w-[760px] text-[13px] leading-[1.55] text-ink-muted">
        This release publishes {packages.length} packages. Every one must be approved
        {gate.requiredApprovals > 1 ? ` by ${gate.requiredApprovals} different members` : ""} before
        the held deployment releases; rejecting any single package blocks the whole release.
      </p>
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
                {isCurrent ? <Badge tone="neutral">this package</Badge> : null}
              </div>
              <div class="flex items-center gap-3 shrink-0">
                <Badge tone={packageDecisionTone(pkg)}>
                  {packageDecisionLabel(pkg, gate.requiredApprovals)}
                </Badge>
                {isCurrent ? (
                  onDecide && pending && !pkg.decision ? (
                    <button
                      type="button"
                      onClick={onDecide}
                      class="font-mono text-[11px] underline text-accent bg-transparent border-0 p-0 cursor-pointer"
                    >
                      decide →
                    </button>
                  ) : (
                    <span class="font-mono text-[11px] text-ink-subtle">shown here</span>
                  )
                ) : (
                  <a
                    class="font-mono text-[11px] underline text-accent"
                    href={`/dashboard/scans/${encodeURIComponent(pkg.scanId)}`}
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

export function GateContextPanel({
  gate,
  packageName,
  canRetry,
  retryStatus,
  retryError,
  onRetry,
}: {
  gate: PublicWorkflowGate | null;
  packageName: string | null;
  canRetry?: boolean;
  retryStatus?: DecisionStatus;
  retryError?: string | null;
  onRetry?: () => void;
}) {
  const retrying = retryStatus === "saving";
  return (
    <section class="flex flex-col gap-3 border border-border rounded-lg p-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel as="h2">Deployment gate</SectionLabel>
        {gate ? (
          <Badge tone={gateStatusTone(gate.status)}>{gateStatusLabel(gate.status)}</Badge>
        ) : null}
      </div>
      <p class="m-0 max-w-[760px] text-[14px] leading-[1.55] text-ink-muted">
        GitHub Actions is holding the publish job
        {packageName ? (
          <>
            {" "}
            for <code>{packageName}</code>
          </>
        ) : null}
        .
      </p>
      {gate ? (
        <MonoDetail
          parts={[
            <span key="repo">{gate.repositoryFullName}</span>,
            <span key="env">env {gate.environment}</span>,
            <span key="run">run #{gate.runId}</span>,
          ]}
        />
      ) : (
        <LoadingLine size="inline">Loading gate context</LoadingLine>
      )}
      {gate?.failureReason ? (
        <Alert tone="critical">
          Drydock blocked this release automatically because the published artifacts could not be
          verified against the reviewed manifest ({gate.failureReason}).
        </Alert>
      ) : null}
      {canRetry && onRetry ? (
        <div class="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={onRetry} disabled={retrying}>
            {retrying ? "Retrying…" : "Retry review"}
          </Button>
          <Muted class="m-0 text-[12px]">
            Re-runs the gate review from the workflow artifacts and replaces the failed batch.
          </Muted>
        </div>
      ) : null}
      {retryError ? <Alert tone="critical">{retryError}</Alert> : null}
    </section>
  );
}

/**
 * What the approve button promises.
 *
 * The distinction that matters under a multi-approval policy is whether this
 * click releases the deployment or just adds a name to the roster — labelling
 * both "Approve & release" would be a lie half the time.
 */
function approveLabel(input: {
  multi: boolean;
  multiApproval: boolean;
  approvalDecidesPackage: boolean;
  reviewFailed: boolean;
}): string {
  if (input.multiApproval && !input.approvalDecidesPackage) {
    return input.reviewFailed ? "Add my approval anyway" : "Add my approval";
  }
  if (input.reviewFailed)
    return input.multi ? "Approve package anyway" : "Approve anyway & release";
  return input.multi ? "Approve package" : "Approve & release";
}

export function GateDecisionDialog({
  open,
  onClose,
  gate,
  packageName,
  packageDecision,
  approvals,
  viewerUserId,
  status,
  error,
  canApprove,
  requireTwoFactor,
  reviewFailed,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  gate: PublicWorkflowGate;
  packageName: string | null;
  /** This package's recorded decision, if it has already been decided. */
  packageDecision: GatePackageDecision | null;
  /** Who has approved this package so far, against the org's bar. */
  approvals?: ScanApprovalState | null;
  viewerUserId?: string | null;
  status: DecisionStatus;
  error: string | null;
  canApprove: boolean;
  requireTwoFactor: boolean;
  reviewFailed?: boolean;
  onSubmit: (
    decision: WorkflowGateDecision,
    comment: string | null,
    totpCode: string | null,
  ) => void | Promise<void>;
}) {
  const commentDraft = useSignal("");
  const codeDraft = useSignal("");
  const saving = status === "saving";
  const gateDecided = gate.status === "approved" || gate.status === "rejected";
  const packageAlreadyDecided = packageDecision !== null;
  const packages = gate.packages;
  const multi = packages.length > 1;
  const approvedCount = packages.filter((pkg) => pkg.decision === "publish").length;
  const multiApproval = isMultiApproval(approvals);
  // This member has already approved this package. The route rejects a second
  // approval from the same person (that is the whole point of the bar), so the
  // approve action is closed off here rather than left to fail — but blocking
  // stays open, because a reviewer who has since seen something bad must be
  // able to stop a release they helped along.
  const alreadyApproved = approvals?.viewerDecision === "publish" && !packageAlreadyDecided;
  // Whether *this* approval is the one that decides the package.
  const approvalDecidesPackage = Boolean(
    approvals &&
    approvals.approvedCount + (approvals.viewerDecision === "publish" ? 0 : 1) >=
      approvals.required,
  );
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
    if (open) {
      commentDraft.value = "";
      codeDraft.value = "";
    }
  }, [open]);

  const submit = (next: WorkflowGateDecision) => {
    if (saving || gateDecided || packageAlreadyDecided || blockedOnCode || mustEnroll) return;
    if (next === "approved" && alreadyApproved) return;
    const trimmed = commentDraft.value.trim();
    void onSubmit(next, trimmed.length ? trimmed : null, needsCode ? code : null);
  };

  const handleClose = () => {
    if (saving) return;
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={multi ? "Package decision" : "Release decision"}
      description={
        multiApproval
          ? `Record your review. This ${multi ? "package" : "release"} counts as approved once ${gate.requiredApprovals} different members approve it, and only then does the held GitHub Actions job release${multi ? " — along with every other package" : ""}. A rejection blocks it immediately. Publishing still runs through your workflow's own publish step, such as Trusted Publishing or OIDC. Drydock never holds your registry credentials.`
          : multi
            ? "Decide this package. The held GitHub Actions job releases only after every package is approved; rejecting any one blocks the whole release. Publishing still runs through your workflow's own publish step, such as Trusted Publishing or OIDC. Drydock never holds your registry credentials."
            : "Approve to release the held GitHub Actions job. Reject to block it. Publishing still runs through your workflow's own publish step, such as Trusted Publishing or OIDC. Drydock never holds your registry credentials or uploads the package."
      }
    >
      <div class="flex flex-col gap-2 border border-border rounded-md p-3">
        <MonoDetail
          parts={[
            packageName ? <span key="pkg">{packageName}</span> : null,
            <span key="repo">{gate.repositoryFullName}</span>,
            <span key="env">env {gate.environment}</span>,
            <span key="run">run #{gate.runId}</span>,
          ]}
        />
        {gateDecided ? (
          <Badge tone={gateStatusTone(gate.status)}>{gateStatusLabel(gate.status)}</Badge>
        ) : packageDecision ? (
          <Badge tone={packageDecision === "publish" ? "ok" : "critical"}>
            this package {packageDecision === "publish" ? "approved" : "rejected"}
          </Badge>
        ) : null}
      </div>

      {multiApproval && approvals && !gateDecided ? (
        <>
          <QuorumUnreachableNotice approvals={approvals} />
          <ApprovalRoster approvals={approvals} viewerUserId={viewerUserId} />
        </>
      ) : null}

      {multi && !gateDecided ? (
        <Muted class="m-0 text-[13px]">
          {approvedCount} of {packages.length} packages approved. All must be approved before the
          held deployment releases.
        </Muted>
      ) : null}

      {reviewFailed && !gateDecided && !packageAlreadyDecided ? (
        <Alert tone="warn">
          This package review failed. Retry the review, or record a human decision based on the
          release evidence you have inspected.
        </Alert>
      ) : null}

      {mustEnroll ? (
        <Alert tone="warn">
          Your organization requires two-factor authentication to approve or block releases. Enable
          it in{" "}
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
          placeholder="e.g. reviewed changed files, no risk signals"
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
            Confirm with the code from your authenticator app to release or block this deployment.
          </Muted>
        </Field>
      ) : null}

      {gateDecided ? (
        <Muted class="m-0 text-[13px]">
          This gate has already been decided. The decision is final, and GitHub has been notified.
        </Muted>
      ) : packageAlreadyDecided ? (
        <Muted class="m-0 text-[13px]">
          This package decision has been recorded. The held deployment stays pending until the
          remaining packages are decided.
        </Muted>
      ) : (
        <div class="flex flex-wrap gap-2">
          {canApprove ? (
            <Button
              onClick={() => submit("approved")}
              disabled={saving || blockedOnCode || mustEnroll || alreadyApproved}
            >
              {saving
                ? "Submitting…"
                : approveLabel({
                    multi,
                    multiApproval,
                    approvalDecidesPackage,
                    reviewFailed: Boolean(reviewFailed),
                  })}
            </Button>
          ) : null}
          <Button
            variant="danger"
            onClick={() => submit("rejected")}
            disabled={saving || blockedOnCode || mustEnroll}
          >
            {saving ? "Submitting…" : "Reject & block release"}
          </Button>
        </div>
      )}
      {alreadyApproved ? (
        <Muted class="m-0 text-[13px]">
          You have already approved this {multi ? "package" : "release"}. It needs a different
          member's approval to release — you can still reject it.
        </Muted>
      ) : null}
      {!gateDecided && !canApprove ? (
        <Muted class="m-0 text-[13px]">
          Approval requires a completed review batch. Retry the review or reject to block the held
          GitHub job.
        </Muted>
      ) : null}
      {error ? <Alert tone="critical">{error}</Alert> : null}
    </Dialog>
  );
}
