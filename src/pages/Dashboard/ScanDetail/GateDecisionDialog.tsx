import { useEffect } from "preact/hooks";
import { useSignal } from "@preact/signals";
import type { DecisionStatus } from "../../../models/scan";
import { scanDetailPath } from "../../../lib/scan-detail-path";
import { formatDateTime } from "../../../lib/format";
import type {
  GatePackageDecision,
  GatePackageScan,
  HeldRelease,
  PublicWorkflowGate,
  WorkflowGateDecision,
} from "../../../models/github-app";
import { Alert } from "../../../components/Alert";
import { Badge, severityTone } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { readSignalProp, type SignalOrValue } from "../../../components/signal-props";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { LoadingLine, MonoDetail, Muted, SectionLabel } from "../../../components/Typography";

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

export interface HeldReleaseLine {
  text: string;
  /** Set only for states that need a person's attention. */
  badge: { label: string; tone: "critical" | "medium" } | null;
  note: string | null;
}

function indexHost(index: string): string {
  try {
    return new URL(index).host;
  } catch {
    return index;
  }
}

/**
 * One line of registry-held session state for the decision dialog. Expected
 * states read as plain text; only the ones that stop or bypass the approval
 * (changed bytes, an expired or failed session, a publish outside Drydock)
 * carry a badge. What approving does depends on the gate: only the approval
 * that completes a pending gate publishes, and a closed gate publishes nothing.
 */
export function heldReleaseLine(
  release: HeldRelease,
  gate: { gateStatus: string; packageCount: number },
): HeldReleaseLine {
  const registry = release.ecosystem === "pypi" ? "PyPI" : release.ecosystem;
  const subject = `${release.projectName} ${release.version} on ${indexHost(release.index)}`;
  const note = release.stateDetail;
  switch (release.state) {
    case "held": {
      if (gate.gateStatus !== "pending") {
        return {
          text: `${registry} holds ${subject}`,
          badge: null,
          note: note ?? "not published; the gate is closed",
        };
      }
      const effect =
        gate.packageCount > 1
          ? "publishes once every package is approved"
          : "approving publishes it";
      return {
        text: `${registry} holds ${subject}`,
        badge: null,
        note:
          release.expiresAt === null
            ? effect
            : `${effect} · expires ${formatDateTime(release.expiresAt)}`,
      };
    }
    case "staging":
      return { text: `Staging ${subject}…`, badge: null, note };
    case "upload_failed":
      return {
        text: subject,
        badge: { label: "upload failed, cannot publish", tone: "critical" },
        note,
      };
    case "superseded":
      return {
        text: subject,
        badge: { label: "taken over by a later run", tone: "medium" },
        note: null,
      };
    case "publishing":
      return { text: `Publishing ${subject}…`, badge: null, note };
    case "published":
      return { text: `Published ${subject}`, badge: null, note };
    case "canceling":
      return { text: `Canceling ${subject}…`, badge: null, note };
    case "canceled":
      return { text: `Canceled ${subject}`, badge: null, note };
    case "externally_canceled":
      return { text: `${subject} was canceled outside Drydock`, badge: null, note };
    case "stale":
      return {
        text: subject,
        badge: { label: "changed since review, cannot publish", tone: "critical" },
        note,
      };
    case "expired":
      return { text: subject, badge: { label: "expired", tone: "medium" }, note };
    case "externally_published":
      return {
        text: subject,
        badge: { label: "published outside Drydock", tone: "critical" },
        note,
      };
    case "token_removed":
      return { text: subject, badge: { label: "token removed", tone: "medium" }, note };
    default:
      return { text: subject, badge: { label: "error", tone: "critical" }, note };
  }
}

/**
 * A blocked gate whose release already partly reached the registry: one
 * project published before another failed, so the approval became a block.
 */
export function partiallyPublished(gateStatus: string, releases: HeldRelease[]): boolean {
  return (
    gateStatus === "rejected" &&
    releases.some((release) => release.state === "published") &&
    releases.some((release) => release.state !== "published")
  );
}

function HeldReleases({
  releases,
  gateStatus,
  packageCount,
}: {
  releases: HeldRelease[];
  gateStatus: string;
  packageCount: number;
}) {
  if (releases.length === 0) return null;
  return (
    <div class="flex flex-col gap-1">
      <Muted class="m-0 font-mono text-[11px]">PEP 694 staged upload · preview</Muted>
      {partiallyPublished(gateStatus, releases) ? (
        <span class="flex flex-wrap items-center gap-2 text-[13px] text-ink">
          <Badge tone="critical">partially published</Badge>
          <span class="text-ink-muted">
            Some projects are live on the index; the rest did not publish.
          </span>
        </span>
      ) : null}
      <ul class="m-0 p-0 list-none flex flex-col gap-1">
        {releases.map((release) => {
          const line = heldReleaseLine(release, { gateStatus, packageCount });
          return (
            <li
              key={`${release.index} ${release.projectName} ${release.version}`}
              class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink"
            >
              <span>{line.text}</span>
              {line.badge ? <Badge tone={line.badge.tone}>{line.badge.label}</Badge> : null}
              {line.note ? <span class="text-ink-muted">· {line.note}</span> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
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
  organizationId,
  onDecide,
}: {
  gate: PublicWorkflowGate;
  currentScanId: string;
  /** A gate's package reviews all belong to the gate's organization. */
  organizationId?: string | null;
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
        This release publishes {packages.length} packages. Every one must be approved before the
        held deployment releases; rejecting any single package blocks the whole job.
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
                {isCurrent ? (
                  onDecide && pending && !pkg.decision ? (
                    <button
                      type="button"
                      onClick={onDecide}
                      class="font-mono text-[11px] underline text-accent bg-transparent border-0 p-0 cursor-pointer"
                    >
                      decide →
                    </button>
                  ) : null
                ) : (
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

export function GateContextPanel({
  gate,
  packageName,
  canRetry,
  retryStatus,
  retryError,
  onRetry,
  lookupStalled,
  onRetryLookup,
}: {
  gate: PublicWorkflowGate | null;
  packageName: string | null;
  canRetry?: boolean;
  retryStatus?: DecisionStatus;
  retryError?: string | null;
  onRetry?: () => void;
  lookupStalled?: boolean;
  onRetryLookup?: () => void;
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
      {gate?.failureReason ? (
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
            Re-runs the gate review from the workflow artifacts and replaces the failed batch.
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
  const gateDecided = gate.status === "approved" || gate.status === "rejected";
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

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={multi ? "Package decision" : "Release decision"}
      description={`${
        multi
          ? "Decide this package. The configured protected GitHub Actions publish job continues only after every package is approved; rejecting any package blocks that job."
          : "Approve to continue the configured protected GitHub Actions publish job, or reject to block that job."
      } ${
        gate.heldReleases.length > 0
          ? "Drydock publishes the held release when the gate is approved and cancels it when it is rejected."
          : "Your workflow publishes with its own registry credentials."
      }`}
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

      {multi && !gateDecided ? (
        <Muted class="m-0 text-[13px]">
          {approvedCount} of {packages.length} packages approved; all must be approved before the
          protected publish job can continue.
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

      <HeldReleases
        releases={gate.heldReleases}
        gateStatus={gate.status}
        packageCount={gate.packages.length}
      />

      {gateDecided ? (
        <Muted class="m-0 text-[13px]">
          GitHub has been notified of this gate's final decision.
        </Muted>
      ) : packageAlreadyDecided ? (
        <Muted class="m-0 text-[13px]">
          This package decision is recorded; the protected publish job stays pending while the
          remaining packages await decisions.
        </Muted>
      ) : (
        <div class="flex flex-wrap gap-2">
          {canApprove ? (
            <Button
              onClick={() => submit("approved")}
              disabled={saving || blockedOnCode || mustEnroll}
            >
              {saving
                ? "Submitting…"
                : reviewFailed
                  ? multi
                    ? "Approve package anyway"
                    : "Approve anyway & continue job"
                  : multi
                    ? "Approve package"
                    : "Approve & continue job"}
            </Button>
          ) : null}
          <Button
            variant="danger"
            onClick={() => submit("rejected")}
            disabled={saving || blockedOnCode || mustEnroll}
          >
            {saving ? "Submitting…" : "Reject & block job"}
          </Button>
        </div>
      )}
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
