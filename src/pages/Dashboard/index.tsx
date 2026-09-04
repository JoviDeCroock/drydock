import { useEffect } from "preact/hooks";
import { useSignal, useModel, useSignalEffect } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { useLocation } from "preact-iso";
import { rememberDashboardReturnUrl, useQuerySignal } from "../../lib/query-state";
import { npmStagedPackagesUrlFor } from "../../lib/npm-staged-url";
import { formatDateTime, pluralize } from "../../lib/format";
import { activeOrganizationId } from "../../models/active-organization";
import { sessionModel } from "../../models/auth";
import {
  closeGettingStartedPanel,
  gettingStartedDone,
  gettingStartedPanelOpen,
  markGettingStartedDone,
  openGettingStartedPanel,
} from "../../models/getting-started";
import { NpmConnectionModel, npmConnectionScope } from "../../models/npm-connection";
import { OrganizationModel } from "../../models/organization";
import {
  ScanListModel,
  type ScanDecision,
  type ScanDecisionFilter,
  type ScanListItem,
} from "../../models/scan";
import { ScanOverviewModel } from "../../models/scan-overview";
import { StagedPublishesModel } from "../../models/staged-publishes";
import { Alert } from "../../components/Alert";
import { Badge, severityTone } from "../../components/Badge";
import { EmailVerificationBanner } from "../../features/account/EmailVerificationBanner";
import { OverviewStrip } from "../../features/overview/OverviewStrip";
import { registryStatusBadge } from "../../features/registry-status";
import { Button, LinkButton } from "../../components/Button";
import { Card } from "../../components/Card";
import { LoadingState } from "../../components/Loading";
import { Menu, MenuItem, MenuLink } from "../../components/Menu";
import { OrgSwitcher } from "../../components/OrgSwitcher";
import { PageShell } from "../../components/PageShell";
import { Select } from "../../components/Select";
import { EmptyLine, Muted, SectionLabel } from "../../components/Typography";
import { UserMenu } from "../../components/UserMenu";
import { GettingStarted } from "./GettingStarted";
import { DeleteScanDialog } from "./ScanDetail/DeleteScanDialog";
import { DecisionDialog } from "./ScanDetail/DecisionDialog";
import { StageCommandDialogHost } from "./ScanDetail/StageCommandDialog";

export default function DashboardPage() {
  const location = useLocation();
  const scans = useModel(ScanListModel);
  const npm = useModel(NpmConnectionModel);
  const organizations = useModel(OrganizationModel);
  const stagedPublishes = useModel(StagedPublishesModel);
  const overview = useModel(ScanOverviewModel);
  const sessionChecked = useSignal(false);

  // Two-way bind the decision filter to ?filter=. The model re-fetches
  // whenever the filter signal changes, so URL → filter → refresh comes
  // for free on browser back/forward.
  useQuerySignal(scans.filter, {
    name: "filter",
    parse: parseDecisionFilter,
    serialize: (value) => (value === "undecided" ? null : value),
  });

  useEffect(() => {
    rememberDashboardReturnUrl(location.url);
  }, [location.url]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const data = await sessionModel.load();
      if (cancelled) return;
      if (!data) {
        location.route("/login", true);
        return;
      }
      sessionChecked.value = true;
      // A first visit has no stored organization ID. Resolve it before the
      // organization-scoped requests so their active scope cannot change while
      // they are in flight.
      await organizations.load();
      if (cancelled) return;
      await Promise.all([scans.refresh(), npm.load(), overview.refresh()]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Every list mutation (refresh, decision, delete, Check npm) changes what
  // the overview counts, so the strip follows the list rather than each action
  // remembering to refresh it. The startup and organization-switch loads above
  // already hold an in-flight request the model joins instead of repeating.
  useSignalEffect(() => {
    void scans.scans.value;
    if (!overview.loaded.peek()) return;
    void overview.refresh();
  });

  const onSwitchOrganization = async (organizationId: string) => {
    if (organizations.activate(organizationId)) {
      await Promise.all([scans.refresh(), npm.load(), overview.refresh()]);
    }
  };

  const onCreateOrganization = async (name: string) => {
    const created = await organizations.create(name);
    if (created) {
      await Promise.all([scans.refresh(), npm.load(), overview.refresh()]);
    }
  };

  useSignalEffect(() => {
    if (!sessionChecked.value) return;
    if (!npm.connection.value?.id) {
      stagedPublishes.reset();
    }
  });

  const onSignOut = async () => {
    await sessionModel.signOut();
    location.route("/", true);
  };

  if (!sessionChecked.value) {
    return (
      <PageShell>
        <DashboardHeader />
        <LoadingState title="Opening workspace" detail="checking session · loading reviews" />
      </PageShell>
    );
  }

  const user = sessionModel.user.value;
  const scansLoaded = scans.loaded.value;
  const npmLoaded = npm.loaded.value;
  const overviewLoaded = overview.loaded.value;
  const workspaceLoaded = scansLoaded && npmLoaded && overviewLoaded;

  return (
    <PageShell
      headerActions={
        <>
          <LinkButton variant="ghost" size="sm" href="/dashboard/settings">
            Settings
          </LinkButton>
          <OrgSwitcher
            organizations={organizations.organizations.value}
            activeOrganizationId={organizations.activeOrganizationId.value}
            busy={organizations.busy.value}
            error={organizations.error.value}
            onActivate={onSwitchOrganization}
            onCreate={onCreateOrganization}
          />
          <UserMenu email={user?.email} name={user?.name} onSignOut={onSignOut} />
        </>
      }
    >
      <DashboardHeader />

      <EmailVerificationBanner />

      {workspaceLoaded ? (
        <>
          <DashboardOnboarding scans={scans} npm={npm} />
          <NpmTokenStaleCallout npm={npm} />
          <OverviewStrip
            overview={overview.overview}
            loaded={overview.loaded}
            error={overview.error}
          />
          <RecentReviewsSection scans={scans} stagedPublishes={stagedPublishes} npm={npm} />
        </>
      ) : (
        <LoadingState
          title="Loading workspace"
          detail={[
            !scansLoaded && "loading reviews",
            !npmLoaded && "checking npm connection",
            !overviewLoaded && "counting the queue",
          ]
            .filter(Boolean)
            .join(" · ")}
        />
      )}
    </PageShell>
  );
}

// Which of the two onboarding surfaces an organization sees, if either.
//
// The getting-started panel supersedes the bare "npm not connected" callout
// while the funnel is unfinished: it says the same thing as step 1 and then
// explains what comes after it. Neither opens on a guess — an unresolved (null)
// answer shows nothing rather than telling a maintainer with a hundred reviews
// to get their first one.
//
// Opening is latched per organization, which is what lets the last step be seen
// ticking: recording a first decision finishes the funnel, and a panel that
// vanished at that moment would take the tick with it. Once open it stays until
// the reader dismisses it; "finished" only means it will not open again.
function DashboardOnboarding({
  scans,
  npm,
}: {
  scans: ReturnType<typeof useModel<typeof ScanListModel.prototype>>;
  npm: ReturnType<typeof useModel<typeof NpmConnectionModel.prototype>>;
}) {
  // Step 3 is the only step whose answer costs a request, so it is asked for
  // only while the panel could still open — never for an organization that has
  // dismissed it or already finished.
  useSignalEffect(() => {
    if (gettingStartedDone.value) return;
    if (!scans.loaded.value) return;
    if (scans.refreshing.value) return;
    if (scans.hasAnyScan.value !== true) return;
    if (scans.hasAnyDecision.value !== null) return;
    void scans.resolveHasAnyDecision();
  });

  // A completed funnel is recorded as finished, which is what keeps the probe
  // above from running again on every later dashboard load in this browser. It
  // deliberately does not close a panel that is already open.
  useSignalEffect(() => {
    if (scans.hasAnyDecision.value === true) markGettingStartedDone();
  });

  useSignalEffect(() => {
    const organizationId = activeOrganizationId.value;
    if (gettingStartedDone.value) return;
    if (scans.hasAnyScan.value === false || scans.hasAnyDecision.value === false) {
      openGettingStartedPanel(organizationId);
    }
  });

  const dismiss = () => {
    closeGettingStartedPanel();
    markGettingStartedDone();
  };

  if (gettingStartedPanelOpen.value) {
    return (
      <GettingStarted
        npmConnected={Boolean(npm.connection.value)}
        npmScope={npmConnectionScope(npm.connection.value)}
        hasAnyScan={scans.hasAnyScan.value === true}
        hasAnyDecision={scans.hasAnyDecision.value === true}
        onDismiss={dismiss}
      />
    );
  }
  if (!npm.connection.value) return <NpmSetupCallout />;
  return null;
}

function DashboardHeader() {
  return (
    <header class="flex flex-col gap-2 max-w-[640px]">
      <h1 class="text-3xl font-semibold tracking-[-0.02em] m-0">Ready for the next release</h1>
      <Muted class="text-[14px] leading-[1.55] m-0">
        Review held npm, PyPI, and VS Code candidates before maintainers let them go live.
      </Muted>
    </header>
  );
}

async function discoverStagedPublishes(
  stagedPublishes: ReturnType<typeof useModel<typeof StagedPublishesModel.prototype>>,
  scans: ReturnType<typeof useModel<typeof ScanListModel.prototype>>,
) {
  const result = await stagedPublishes.discover();
  await scans.refresh({ preserveLoaded: true });
  if (result) scans.scheduleRegistryStatusRefreshes();
}

function RecentReviewsSection({
  scans,
  stagedPublishes,
  npm,
}: {
  scans: ReturnType<typeof useModel<typeof ScanListModel.prototype>>;
  stagedPublishes: ReturnType<typeof useModel<typeof StagedPublishesModel.prototype>>;
  npm: ReturnType<typeof useModel<typeof NpmConnectionModel.prototype>>;
}) {
  const ready = npm.validated.value;
  const discovery = stagedPublishes.lastResult.value;
  const discoveryError = stagedPublishes.error.value;
  const discoveryRefreshing = stagedPublishes.refreshing.value;
  const quickDecisionScan = useSignal<ScanListItem | null>(null);
  const deleteScan = useSignal<ScanListItem | null>(null);
  const startedLabels = discovery?.scans.map(formatStartedScanLabel).filter(Boolean) ?? [];
  const onDiscover = async () => {
    await discoverStagedPublishes(stagedPublishes, scans);
  };
  const onQuickDecisionSubmit = async (decision: ScanDecision, reason: string | null) => {
    const scan = quickDecisionScan.peek();
    if (!scan) return false;
    await scans.setDecision(scan.id, decision, reason);
    const saved = scans.decisionStatus.peek() === "idle";
    if (saved) {
      quickDecisionScan.value = null;
    }
    return saved;
  };
  const onDeleteConfirm = async () => {
    const scan = deleteScan.peek();
    if (!scan) return false;
    const deleted = await scans.deleteFailed(scan.id);
    if (deleted) deleteScan.value = null;
    return deleted;
  };

  const discoveredAt = stagedPublishes.lastDiscoveryAt.value;
  const showFreshness = discoveredAt !== null && !discoveryError && !discoveryRefreshing;
  const showStartedMessage = Boolean(discovery && !discoveryError && discovery.created);
  const showNoOpenMessage = Boolean(
    discovery && !discoveryError && !discovery.created && !discovery.found,
  );
  const showDiscoveryFeedback = Boolean(
    discoveryError || showFreshness || showStartedMessage || showNoOpenMessage,
  );

  return (
    <Card as="section" padding="none" class="overflow-hidden">
      <div class="px-5 py-4 flex flex-col gap-3 md:flex-row md:items-center">
        <SectionLabel as="h2" class="flex-1 min-w-0 after:hidden">
          Recent reviews
        </SectionLabel>
        <div class="flex flex-wrap items-center gap-2 shrink-0">
          <ScanStateSelect
            value={scans.filter.value}
            disabled={scans.refreshing.value}
            onChange={(filter) => (scans.filter.value = filter)}
          />
          {/* A disabled control with the reason only in a tooltip is a dead
              end on touch and for screen readers, so the unmet requirement is
              rendered as text with the link that resolves it. */}
          {ready ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void onDiscover()}
              disabled={discoveryRefreshing}
              title="Find staged npm publishes and start reviews"
            >
              {discoveryRefreshing ? "Checking npm…" : "Check npm"}
            </Button>
          ) : (
            <Muted class="text-[13px] m-0">
              Checking npm for staged releases needs a validated npm token.{" "}
              <a href="/dashboard/settings?tab=integrations" class="underline">
                Connect one
              </a>
              .
            </Muted>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void scans.refresh()}
            disabled={scans.refreshing.value}
            title="Reload the reviews list"
          >
            {scans.refreshing.value ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </div>
      {showDiscoveryFeedback ? (
        <div class="px-5 pb-4 flex flex-col gap-2">
          {discoveryError ? <Alert tone="critical">{discoveryError}</Alert> : null}
          {showFreshness ? <ScanFreshnessIndicator at={discoveredAt} /> : null}
          {showStartedMessage && discovery ? (
            <Muted class="text-[13px] m-0">
              {`Started ${discovery.created} new review${discovery.created === 1 ? "" : "s"} from npm${
                startedLabels.length ? `: ${startedLabels.slice(0, 3).join(", ")}` : ""
              }${startedLabels.length > 3 ? `, +${startedLabels.length - 3} more` : ""}.`}
            </Muted>
          ) : null}
          {showNoOpenMessage ? (
            <Muted class="text-[13px] m-0">No open staged publishes found.</Muted>
          ) : null}
        </div>
      ) : null}
      <div class="border-t border-border">
        {scans.scans.value.length ? (
          <ScanRows
            scans={scans.scans.value}
            quickDecisionScanId={quickDecisionScan.value?.id ?? null}
            decisionSaving={scans.decisionStatus.value === "saving"}
            deleteBusy={scans.deleteStatus.value === "deleting"}
            onQuickDecide={(scan) => {
              scans.decisionError.value = null;
              quickDecisionScan.value = scan;
            }}
            onDelete={(scan) => {
              scans.deleteError.value = null;
              deleteScan.value = scan;
            }}
          />
        ) : (
          <div class="p-5">
            <EmptyLine>{emptyStateMessage(scans.filter.value, scans.hasAnyScan.value)}</EmptyLine>
          </div>
        )}
      </div>
      {scans.nextCursor.value ? (
        <div class="border-t border-border px-5 py-4 flex justify-center">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void scans.loadMore()}
            disabled={scans.loadingMore.value || scans.refreshing.value}
          >
            {scans.loadingMore.value ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
      <Show<ScanListItem | null> when={quickDecisionScan}>
        {(scan) => (
          <DecisionDialog
            open={true}
            onClose={() => (quickDecisionScan.value = null)}
            decision={scan.decision}
            decisionReason={scan.decisionReason}
            decidedAt={scan.decidedAt}
            status={scans.decisionStatus.value}
            error={scans.decisionError.value}
            npmStagedPackagesUrl={npmStagedPackagesUrlFor(scan)}
            scan={scan}
            onSubmit={onQuickDecisionSubmit}
          />
        )}
      </Show>
      <StageCommandDialogHost />
      <Show<ScanListItem | null> when={deleteScan}>
        {(scan) => (
          <DeleteScanDialog
            open={true}
            onClose={() => (deleteScan.value = null)}
            packageName={scan.packageName}
            status={scans.deleteStatus.value}
            error={scans.deleteError.value}
            onConfirm={onDeleteConfirm}
          />
        )}
      </Show>
    </Card>
  );
}

const FILTER_OPTIONS: Array<{ value: ScanDecisionFilter; label: string }> = [
  { value: "undecided", label: "Undecided" },
  {
    value: "published_without_decision",
    label: "Published without Drydock decision",
  },
  { value: "publish", label: "Approved" },
  { value: "no_publish", label: "Blocked" },
  { value: "all", label: "All" },
];

const FILTER_VALUES: ReadonlySet<ScanDecisionFilter> = new Set(
  FILTER_OPTIONS.map((option) => option.value),
);

function parseDecisionFilter(raw: string | undefined): ScanDecisionFilter {
  return raw && FILTER_VALUES.has(raw as ScanDecisionFilter)
    ? (raw as ScanDecisionFilter)
    : "undecided";
}

function ScanStateSelect({
  value,
  disabled,
  onChange,
}: {
  value: ScanDecisionFilter;
  disabled: boolean;
  onChange: (filter: ScanDecisionFilter) => void;
}) {
  return (
    <label class="flex items-center gap-2">
      <span class="sr-only">Review state</span>
      <span aria-hidden class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
        State
      </span>
      <span class="w-[260px]">
        <Select
          id="scan-state-filter"
          size="sm"
          value={value}
          disabled={disabled}
          onChange={(next) => onChange(parseDecisionFilter(next))}
        >
          {FILTER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </span>
    </label>
  );
}

// `hasAnyScan` is what keeps this honest. The list defaults to the "undecided"
// filter, so an organization with no scans at all used to read "Nothing waiting
// on you. Switch to All to see earlier reviews." — copy that points a brand-new
// user at a filter which is also empty, and implies a review history they do
// not have. That sentence is right for an organization that *has* history, so
// it stays for that case and only the never-scanned case gets its own wording.
// Per docs/design.md the empty state is one muted sentence with no CTA inside it —
// the getting-started panel above carries the affordances.
function emptyStateMessage(filter: ScanDecisionFilter, hasAnyScan: boolean | null): string {
  if (hasAnyScan === false) {
    return "No reviews yet — stage a release, or check npm for one already waiting.";
  }
  switch (filter) {
    case "undecided":
      return "Nothing waiting on you. Switch to All to see earlier reviews.";
    case "published_without_decision":
      return "No npm releases were published without a Drydock decision.";
    case "publish":
      return "No approved reviews yet.";
    case "no_publish":
      return "No blocked reviews yet.";
    default:
      return "No reviews yet. Check npm or wait for auto-discovery to find a staged release.";
  }
}

// A non-valid stored token is a failure, not a setup step, so it gets a callout
// above the reviews box. Invalid tokens stop all discovery; unvalidated tokens
// keep their scheduled retry while the on-demand action remains unavailable.
function NpmTokenStaleCallout({
  npm,
}: {
  npm: ReturnType<typeof useModel<typeof NpmConnectionModel.prototype>>;
}) {
  return (
    <Show<string | null>
      when={() => {
        const status = npm.connection.value?.validationStatus;
        return status && status !== "valid" ? status : null;
      }}
    >
      {(status) => (
        <Alert tone="warn">
          {status === "unvalidated" ? (
            <>
              <strong>Check npm is paused.</strong> The stored npm token has not validated, so
              on-demand discovery is unavailable. Scheduled discovery will retry validation
              automatically, or revalidate it now in{" "}
            </>
          ) : (
            <>
              <strong>npm discovery is paused.</strong> The stored npm token is invalid, so
              &ldquo;Check npm&rdquo; and scheduled discovery are unavailable. Revalidate it in{" "}
            </>
          )}
          <a class="underline text-accent" href="/dashboard/settings?tab=integrations">
            Settings &rarr; Integrations
          </a>
          .
        </Alert>
      )}
    </Show>
  );
}

function formatStartedScanLabel(scan: { packageName: string | null; version: string | null }) {
  if (scan.packageName && scan.version) return `${scan.packageName}@${scan.version}`;
  return scan.packageName || scan.version || null;
}

function NpmSetupCallout() {
  return (
    <Card as="section" class="p-5 flex flex-wrap items-center justify-between gap-3">
      <div class="flex flex-col gap-1.5 min-w-0">
        <SectionLabel as="h2">npm not connected</SectionLabel>
        <Muted class="text-[13px] m-0">
          Connect npm in settings so Drydock can fetch staged tarballs and run reviews.
        </Muted>
      </div>
      <LinkButton variant="primary" size="sm" href="/dashboard/settings?tab=integrations">
        Open settings
      </LinkButton>
    </Card>
  );
}

/**
 * One row per review, led by the risk chip and the change it describes.
 *
 * This replaced a seven-column table: a column grid gave "Status" and
 * "Decision" the same visual weight as the diff, and forced every row to the
 * width of its widest cell. Rows put the release delta on the first line and
 * demote provenance and timing to a muted second line.
 */
function ScanRows({
  scans,
  quickDecisionScanId,
  decisionSaving,
  deleteBusy,
  onQuickDecide,
  onDelete,
}: {
  scans: ScanListItem[];
  quickDecisionScanId: string | null;
  decisionSaving: boolean;
  deleteBusy: boolean;
  onQuickDecide: (scan: ScanListItem) => void;
  onDelete: (scan: ScanListItem) => void;
}) {
  return (
    <ul class="list-none p-0 m-0">
      {scans.map((scan) => (
        <li
          key={scan.id}
          class="border-b border-border last:border-b-0 px-5 py-3.5 transition-colors duration-150 hover:bg-surface-2"
        >
          <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div class="flex min-w-0 flex-col gap-1.5">
              <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 min-w-0">
                <ScanRiskChip scan={scan} />
                <a
                  href={`/dashboard/scans/${encodeURIComponent(scan.id)}`}
                  class="min-w-0 truncate text-[14px] font-medium"
                >
                  {scanTitle(scan)}
                </a>
                {scan.previousVersion ? (
                  <span class="font-mono text-[11px] text-ink-subtle whitespace-nowrap">
                    from {scan.previousVersion}
                  </span>
                ) : null}
                <ScanDiffSummary scan={scan} />
                <DecisionBadge decision={scan.decision} />
                <RegistryStatusBadge scan={scan} />
              </div>
              <p class="m-0 font-mono text-[11px] text-ink-subtle">{scanMetaLine(scan)}</p>
            </div>
            <div class="flex items-center gap-2">
              {canQuickDecide(scan) ? (
                <Button
                  variant={scan.decision ? "secondary" : "primary"}
                  size="sm"
                  onClick={() => onQuickDecide(scan)}
                  disabled={decisionSaving}
                  title="Record a decision without leaving the dashboard"
                >
                  {decisionSaving && quickDecisionScanId === scan.id
                    ? "Saving…"
                    : scan.decision
                      ? "Update"
                      : "Decide"}
                </Button>
              ) : null}
              <Menu
                align="end"
                triggerAriaLabel={`More actions for ${scan.packageName || scan.stageId}`}
                triggerClass="inline-flex items-center justify-center h-7 w-7 rounded-md border border-transparent text-ink-muted hover:bg-surface-2 hover:text-ink transition-colors duration-150"
                trigger={() => (
                  <span aria-hidden="true" class="text-[13px] leading-none">
                    ⋯
                  </span>
                )}
              >
                <MenuLink href={`/dashboard/scans/${encodeURIComponent(scan.id)}`}>
                  Open review
                </MenuLink>
                {scan.status === "failed" ? (
                  <MenuItem tone="danger" onSelect={() => onDelete(scan)} disabled={deleteBusy}>
                    Delete review
                  </MenuItem>
                ) : null}
              </Menu>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function scanTitle(scan: ScanListItem): string {
  const name = scan.packageName || scan.stageId;
  return scan.stagedVersion ? `${name}@${scan.stagedVersion}` : name;
}

const SCAN_SOURCE_LABELS: Record<string, string> = {
  manual: "started by hand",
  auto_discovery: "found on npm",
  workflow_gate: "workflow gate",
};

// Provenance and timing: real context, but never the reason a row is read.
function scanMetaLine(scan: ScanListItem): string {
  const source = scan.source ?? "manual";
  const parts = [SCAN_SOURCE_LABELS[source] ?? source];
  if (scan.decidedAt) parts.push(`decided ${formatDateTime(scan.decidedAt)}`);
  else if (scan.completedAt) parts.push(`reviewed ${formatDateTime(scan.completedAt)}`);
  else parts.push(`queued ${formatDateTime(scan.createdAt)}`);
  return parts.join(" · ");
}

function canQuickDecide(scan: ScanListItem): boolean {
  return (
    scan.status === "complete" &&
    scan.source !== "workflow_gate" &&
    scan.registryStatusSupersededAt == null
  );
}

// The row leads with release risk once there is one. A queued, running, or
// failed review has none, so its lifecycle status takes the leading slot rather
// than a placeholder that would claim a grade the review never reached.
function ScanRiskChip({ scan }: { scan: ScanListItem }) {
  if (scan.status !== "complete") return <ScanStatusBadge status={scan.status} />;
  const releaseRisk = scan.riskSummary?.releaseRisk ?? scan.risk;
  return <Badge tone={severityTone(releaseRisk)}>{releaseRisk}</Badge>;
}

/**
 * What the release changed, in the two numbers a reviewer opens the row for.
 *
 * Both already ride the list projection (`changed_file_count` and the
 * denormalized `risk_summary_json`), so a page of rows still costs no finding
 * read. `releaseFindingCount` is the release delta — findings on lines this
 * version introduced — which is why it reads as "on changed lines" rather than
 * as the artifact's total.
 */
function ScanDiffSummary({ scan }: { scan: ScanListItem }) {
  if (scan.status !== "complete") return null;
  const changedFiles = scan.changedFileCount ?? 0;
  const releaseFindings = scan.riskSummary?.releaseFindingCount ?? 0;
  return (
    <span class="font-mono text-[11px] text-ink-muted whitespace-nowrap">
      {changedFiles} {pluralize("file", changedFiles)} changed
      {releaseFindings
        ? ` · ${releaseFindings} ${pluralize("finding", releaseFindings)} on changed lines`
        : ""}
    </span>
  );
}

// Shares the Decision cell rather than taking a column of its own: the pair
// "what we decided / what npm did with it" is one thought, and the two only
// ever disagree in ways worth reading together. Absent for most rows — a
// release npm has merely staged says nothing this page does not already show.
function RegistryStatusBadge({ scan }: { scan: ScanListItem }) {
  const badge = registryStatusBadge(scan);
  if (!badge) return null;
  return <Badge tone={badge.tone}>{badge.label}</Badge>;
}

function DecisionBadge({ decision }: { decision?: string | null }) {
  if (decision === "publish") return <Badge tone="ok">approved</Badge>;
  if (decision === "no_publish") return <Badge tone="critical">blocked</Badge>;
  return <Badge tone="neutral">undecided</Badge>;
}

// Status and Decision are both state columns, so both render as Badges (Status
// was previously raw mono text). Lifecycle status is not a severity: only a
// failed run is critical; running is info; pending/complete stay neutral.
function ScanStatusBadge({ status }: { status: string }) {
  const tone = status === "failed" ? "critical" : status === "running" ? "info" : "neutral";
  return <Badge tone={tone}>{status}</Badge>;
}

// Freshness is shown as a readable mono line ("checked 2 minutes ago") rather
// than a bare ✓ — the check read as a pass/fail state it doesn't represent, and
// its meaning was hidden in a tooltip.
function ScanFreshnessIndicator({ at }: { at: number }) {
  const now = useSignal(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => {
      now.value = Date.now();
    }, 30_000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span class="font-mono text-[11px] text-ink-subtle whitespace-nowrap select-none">
      checked {formatRelativeTime(at, now.value)}
    </span>
  );
}

function formatRelativeTime(at: number, now: number): string {
  const diff = Math.max(0, now - at);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
