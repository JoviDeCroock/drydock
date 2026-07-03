import { getDashboardReturnUrl } from "../../../lib/query-state";
import { formatDateTime } from "../../../lib/format";
import { reportExportFilename } from "../../../../server/lib/report-export";
import type { PersistedScanDetail } from "../../../models/scan";
import {
  Alert,
  Badge,
  Button,
  LinkButton,
  LoadingLine,
  MonoDetail,
  severityTone,
} from "../../../components";

export function ScanDetailHeader({
  detail,
  onDecideClick,
}: {
  detail?: PersistedScanDetail | null;
  onDecideClick?: () => void;
} = {}) {
  const decision = detail?.scan.decision;
  const decidedAt = detail?.scan.decidedAt;
  const isComplete = detail?.scan.status === "complete";
  const releaseRisk = isComplete ? (detail.riskSummary?.releaseRisk ?? detail.scan.risk) : null;
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
            ]}
          />
        ) : (
          <LoadingLine size="inline">Loading saved review</LoadingLine>
        )}
      </div>
      {decision || onDecideClick || (detail && isComplete) ? (
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
        </div>
      ) : null}
    </header>
  );
}

function reportExportHref(detail: PersistedScanDetail): string {
  const href = `/api/v1/scans/${encodeURIComponent(detail.scan.id)}/report.json`;
  const organizationId = detail.scan.organizationId;
  return organizationId ? `${href}?organizationId=${encodeURIComponent(organizationId)}` : href;
}

export function VersionPickerSkeleton({ stagedVersion }: { stagedVersion: string | null }) {
  return (
    <div class="flex flex-wrap items-center gap-3" aria-busy="true">
      <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
        Compare against
      </span>
      <div class="flex items-center bg-bg border border-border rounded-md text-[13px] text-ink-muted pl-3 pr-8 py-2 font-mono min-w-[200px] opacity-60">
        loading versions<span class="ml-0.5 motion-safe:animate-pulse">…</span>
      </div>
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
