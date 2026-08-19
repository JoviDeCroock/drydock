import type { ReadonlySignal } from "@preact/signals";
import { getDashboardReturnUrl } from "../../../lib/query-state";
import { formatDateTime } from "../../../lib/format";
import { reportExportFilename } from "../../../../server/lib/scan/report-export";
import type { PersistedScanDetail, PublicShareInfo } from "../../../models/scan";
import { Alert } from "../../../components/Alert";
import { Badge, severityTone } from "../../../components/Badge";
import { Button, LinkButton } from "../../../components/Button";
import { registryStatusBadge } from "./RegistryStatusNotice";
import { LoadingLine, MonoDetail, MonoLabel } from "../../../components/Typography";

/**
 * Whether the header offers the Share action.
 *
 * A public report is the organization vouching for a release, so the offer only
 * appears once someone has approved it — an undecided or blocked release has
 * nothing to vouch for yet. An already-shared release keeps the action whatever
 * it was decided afterwards: flipping approved → blocked would otherwise strand
 * a live public link with no way to reach the revoke button.
 */
export function shouldOfferShare(
  decision: string | null | undefined,
  hasShareLink: boolean,
): boolean {
  return decision === "publish" || hasShareLink;
}

export function ScanDetailHeader({
  detail,
  onDecideClick,
  onDeleteClick,
  onShareClick,
  shareSignal,
}: {
  detail?: PersistedScanDetail | null;
  onDecideClick?: () => void;
  onDeleteClick?: () => void;
  onShareClick?: () => void;
  shareSignal?: ReadonlySignal<PublicShareInfo | null>;
} = {}) {
  const decision = detail?.scan.decision;
  const decidedAt = detail?.scan.decidedAt;
  const isComplete = detail?.scan.status === "complete";
  const releaseRisk = isComplete ? (detail.riskSummary?.releaseRisk ?? detail.scan.risk) : null;
  // npm's own state for the version, next to our risk verdict. The two answer
  // different questions and are deliberately labelled so nobody reads
  // "npm blocked" as Drydock's finding, or a clean release risk as proof the
  // version shipped.
  const registryBadge = detail ? registryStatusBadge(detail.scan) : null;
  const dashboardHref = getDashboardReturnUrl();
  return (
    <header class="flex flex-wrap items-start justify-between gap-4">
      <div class="flex flex-col gap-2 min-w-0">
        <a href={dashboardHref} class="text-[13px] text-ink-muted hover:text-ink no-underline">
          ← Reviews
        </a>
        <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">
          {detail?.scan.packageName || "Release review"}
        </h1>
        {detail ? (
          <MonoDetail
            parts={[
              <span key="version">
                {detail.scan.previousVersion || "—"} → {detail.scan.stagedVersion || "—"}
              </span>,
              releaseRisk ? (
                <Badge key="risk" tone={severityTone(releaseRisk)}>
                  release {releaseRisk}
                </Badge>
              ) : null,
              registryBadge ? (
                <Badge key="registry" tone={registryBadge.tone}>
                  {registryBadge.label}
                </Badge>
              ) : null,
            ]}
          />
        ) : (
          <LoadingLine size="inline">Loading saved review</LoadingLine>
        )}
      </div>
      {decision || onDecideClick || onDeleteClick || (detail && isComplete) ? (
        <div class="flex flex-wrap items-start gap-3">
          {decision ? (
            <div class="flex flex-col items-end gap-1">
              <Badge tone={decision === "publish" ? "ok" : "critical"}>
                {decision === "publish" ? "approved" : "blocked"}
              </Badge>
              {decidedAt ? (
                <span class="font-mono text-[11px] text-ink-subtle">
                  {formatDateTime(decidedAt)}
                </span>
              ) : null}
            </div>
          ) : null}
          {detail && isComplete && onShareClick ? (
            <ShareAction decision={decision} shareSignal={shareSignal} onClick={onShareClick} />
          ) : null}
          {detail && isComplete ? (
            <LinkButton
              variant="ghost"
              size="sm"
              href={reportExportHref(detail)}
              download={reportExportFilename(detail.scan)}
            >
              Export JSON
            </LinkButton>
          ) : null}
          {onDecideClick ? (
            <Button variant={decision ? "secondary" : "primary"} onClick={onDecideClick}>
              {decision ? "Update decision" : "Decide"}
            </Button>
          ) : null}
          {onDeleteClick ? (
            <Button variant="danger" onClick={onDeleteClick}>
              Delete review
            </Button>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}

/**
 * Own boundary component so the share signal's subscription stays here: enable
 * and revoke round-trips re-render this button, not the whole workbench. That
 * is why `model.share` is deliberately kept out of the scan detail payload.
 */
function ShareAction({
  decision,
  shareSignal,
  onClick,
}: {
  decision: string | null | undefined;
  shareSignal?: ReadonlySignal<PublicShareInfo | null>;
  onClick: () => void;
}) {
  if (!shouldOfferShare(decision, shareSignal?.value != null)) return null;
  return (
    <Button variant="ghost" size="sm" onClick={onClick}>
      Share
    </Button>
  );
}

function reportExportHref(detail: PersistedScanDetail): string {
  const href = `/api/v1/scans/${encodeURIComponent(detail.scan.id)}/report.json`;
  const organizationId = detail.scan.organizationId;
  return organizationId ? `${href}?organizationId=${encodeURIComponent(organizationId)}` : href;
}

export function VersionPickerSkeleton({ stagedVersion }: { stagedVersion: string | null }) {
  // The sanctioned inline loading line, not a faked disabled select — that
  // reimplemented LoadingLine without its aria-live and edged into the
  // "skeleton bone" shape docs/design.md bans. min-h matches the md Select's
  // rendered height (13px × 1.55 + 2×8px padding + 2px border ≈ 38px) so the
  // header doesn't shift when the real picker mounts.
  return (
    <div class="flex flex-wrap items-center gap-3 min-h-[38px]" aria-busy="true">
      <MonoLabel>Compare against</MonoLabel>
      <LoadingLine size="inline">loading versions</LoadingLine>
      <span class="font-mono text-[11px] text-ink-muted">→ staged {stagedVersion || "—"}</span>
    </div>
  );
}

// Token-scope failures are an onboarding dead end without a pointer to the fix:
// connect-time validation only checks whoami + stage listing, so a granular token
// can validate fine and still 403 on a specific package's tarball.
const FAILURE_GUIDANCE: Record<string, { hint: string; action: string }> = {
  staged_tarball_unavailable: {
    hint: "The npm token may have expired, or its scope may not cover this package.",
    action: "Validate or rotate the token under Settings → npm access.",
  },
};

export function ScanFailureAlert({ errorJson }: { errorJson: unknown }) {
  const error =
    errorJson && typeof errorJson === "object"
      ? (errorJson as { message?: unknown; code?: unknown })
      : null;
  const guidance = typeof error?.code === "string" ? FAILURE_GUIDANCE[error.code] : undefined;
  return (
    <Alert tone="critical">
      <div class="flex flex-col gap-1">
        <strong>{typeof error?.message === "string" ? error.message : "Review failed."}</strong>
        {guidance ? (
          <span>
            {guidance.hint} <a href="/dashboard/settings?tab=integrations">{guidance.action}</a>
          </span>
        ) : null}
        {typeof error?.code === "string" ? (
          <span class="font-mono text-xs">code: {error.code}</span>
        ) : null}
      </div>
    </Alert>
  );
}
