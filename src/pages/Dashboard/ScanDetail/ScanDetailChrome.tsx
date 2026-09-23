import type { ComponentChildren } from "preact";
import type { ReadonlySignal } from "@preact/signals";
import { dashboardReturnLabel, getDashboardReturnUrl } from "../../../lib/query-state";
import { packageReleasesPath } from "../../../lib/package-releases-path";
import { scanEcosystem } from "../../../../server/lib/public-feed";
import { formatDateTime } from "../../../lib/format";
import { reportExportFilename } from "../../../../server/lib/scan/report-export";
import type { PersistedScanDetail, PublicShareInfo } from "../../../models/scan";
import { Alert } from "../../../components/Alert";
import { Button, LinkButton } from "../../../components/Button";
import { registryStatusBadge } from "../../../features/registry-status";
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

/**
 * The page header says what this release is and where it stands outside
 * Drydock; the verdict strip below it says what Drydock thinks. Keeping the
 * risk grade and the comparison out of here is deliberate: each was stated
 * twice when the header also carried them, and the metadata line stays plain
 * text because a colored chip in it competes with the verdict for attention.
 */
export function ScanDetailHeader({
  detail,
  decision,
  onDeleteClick,
  onShareClick,
  shareSignal,
}: {
  detail?: PersistedScanDetail | null;
  decision?: ComponentChildren;
  onDeleteClick?: () => void;
  onShareClick?: () => void;
  shareSignal?: ReadonlySignal<PublicShareInfo | null>;
} = {}) {
  const isComplete = detail?.scan.status === "complete";
  // Labelled "npm …" so nobody reads "npm blocked" as Drydock's finding, or a
  // clean verdict as proof the version shipped. States that need action also
  // get a RegistryStatusNotice below; this line only records the observation.
  const registryPhrase = detail ? (registryStatusBadge(detail.scan)?.label ?? null) : null;
  const registryObservedAt =
    registryPhrase && detail?.scan.registryVersionStatusAt
      ? formatDateTime(detail.scan.registryVersionStatusAt)
      : null;
  const dashboardHref = getDashboardReturnUrl();
  const packageHref = detail?.scan.packageName
    ? packageReleasesPath(
        detail.scan.packageName,
        scanEcosystem(detail.scan.source ?? "manual", detail.scan.summaryJson),
      )
    : null;
  return (
    <header class="flex flex-wrap items-start justify-between gap-4">
      <div class="flex flex-col gap-2 min-w-0">
        <a href={dashboardHref} class="text-[13px] text-ink-muted hover:text-ink no-underline">
          ← {dashboardReturnLabel(dashboardHref)}
        </a>
        <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">
          {detail?.scan.packageName || "Release review"}
        </h1>
        {detail ? (
          <MonoDetail
            parts={[
              detail.scan.stagedVersion ? (
                <span key="version">staged {detail.scan.stagedVersion}</span>
              ) : null,
              registryPhrase ? (
                <span key="registry">
                  {registryPhrase}
                  {registryObservedAt ? ` as of ${registryObservedAt}` : null}
                </span>
              ) : null,
              packageHref && !sameLocation(packageHref, dashboardHref) ? (
                <a key="package" href={packageHref} class="text-ink-muted hover:text-ink">
                  all releases →
                </a>
              ) : null,
            ]}
          />
        ) : (
          <LoadingLine size="inline">Loading saved review</LoadingLine>
        )}
      </div>
      {decision || onDeleteClick || (detail && isComplete) ? (
        <div class="flex flex-wrap items-center gap-3 sm:self-end">
          {detail && isComplete ? (
            <div
              role="group"
              class="flex flex-wrap items-center gap-1"
              aria-label="Review utilities"
            >
              {onShareClick ? (
                <ShareAction
                  decision={detail.scan.decision}
                  shareSignal={shareSignal}
                  onClick={onShareClick}
                />
              ) : null}
              <LinkButton
                variant="ghost"
                size="sm"
                href={reportExportHref(detail)}
                download={reportExportFilename(detail.scan)}
              >
                Export JSON
              </LinkButton>
            </div>
          ) : null}
          {decision}
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
 * The recorded decision beside the button that changes it. Plain text rather
 * than a Badge: a decision someone already made is settled state, not an alert,
 * and a filled chip here out-shouted the verdict it answers.
 */
export function DecisionControl({
  decision,
  decidedAt,
  onDecideClick,
}: {
  decision: string | null | undefined;
  decidedAt?: string | number | Date | null;
  onDecideClick?: () => void;
}) {
  if (!decision && !onDecideClick) return null;
  return (
    <div class="flex flex-wrap items-center gap-3">
      {decision ? (
        <p class="m-0 font-mono text-[11px] text-ink-subtle">
          <span class="sr-only">Decision: </span>
          <span class={decision === "publish" ? "text-ok-text" : "text-danger-text"}>
            {decision === "publish" ? "approved" : "blocked"}
          </span>
          {decidedAt ? ` ${formatDateTime(decidedAt)}` : null}
        </p>
      ) : null}
      {onDecideClick ? (
        <Button variant={decision ? "secondary" : "primary"} onClick={onDecideClick}>
          {decision ? "Update decision" : "Decide"}
        </Button>
      ) : null}
    </div>
  );
}

// The asset layer canonicalizes `@` to `%40` on a hard load, so the remembered
// return URL and a freshly built package link can spell the same page two
// ways. Offering "all releases" next to a back link that already goes there
// is noise.
function sameLocation(a: string, b: string): boolean {
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  return decode(a) === decode(b);
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
