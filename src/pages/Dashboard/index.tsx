import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { useSignal, useModel, useSignalEffect } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { useLocation } from "preact-iso";
import { rememberDashboardReturnUrl, useQuerySignal } from "../../lib/query-state";
import { npmStagedPackagesUrlFor } from "../../lib/npm-staged-url";
import { pluralize } from "../../lib/format";
import { activeOrganizationId } from "../../models/active-organization";
import { sessionModel } from "../../models/auth";
import {
  closeGettingStartedPanel,
  gettingStartedDone,
  gettingStartedPanelOpen,
  markGettingStartedDone,
  openGettingStartedPanel,
} from "../../models/getting-started";
import { NpmConnectionModel } from "../../models/npm-connection";
import { OrganizationModel } from "../../models/organization";
import {
  ScanListModel,
  type ScanDecision,
  type ScanDecisionFilter,
  type ScanListItem,
} from "../../models/scan";
import { StagedPublishesModel } from "../../models/staged-publishes";
import { Alert } from "../../components/Alert";
import { Badge, severityTone } from "../../components/Badge";
import { registryStatusBadge } from "../../features/registry-status";
import { Button, LinkButton } from "../../components/Button";
import { Card } from "../../components/Card";
import { LoadingState } from "../../components/Loading";
import { Menu, MenuItem, MenuLink } from "../../components/Menu";
import { OrgSwitcher } from "../../components/OrgSwitcher";
import { PageShell } from "../../components/PageShell";
import { Select } from "../../components/Select";
import { EmptyLine, Eyebrow, Muted, SectionLabel } from "../../components/Typography";
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
      await Promise.all([organizations.load(), scans.refresh(), npm.load()]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onSwitchOrganization = async (organizationId: string) => {
    if (organizations.activate(organizationId)) {
      await Promise.all([scans.refresh(), npm.load()]);
    }
  };

  const onCreateOrganization = async (name: string) => {
    const created = await organizations.create(name);
    if (created) {
      await Promise.all([scans.refresh(), npm.load()]);
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
  const workspaceLoaded = scansLoaded && npmLoaded;

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

      {workspaceLoaded ? (
        <>
          <DashboardOnboarding scans={scans} npm={npm} />
          <RecentReviewsSection scans={scans} stagedPublishes={stagedPublishes} npm={npm} />
        </>
      ) : (
        <LoadingState
          title="Loading workspace"
          detail={
            npmLoaded
              ? "fetching recent reviews"
              : scansLoaded
                ? "checking npm connection"
                : "loading reviews · checking npm connection"
          }
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
      <Eyebrow>Review workspace</Eyebrow>
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
  // Why "Check npm" is disabled, as text. It used to be a `title` tooltip only,
  // which is invisible on touch and to keyboard users — the two audiences most
  // likely to be stuck on a button that does nothing when pressed.
  const discoveryBlockedReason = ready ? null : npmConnectionBlockedReason(npm.connection.value);
  const showDiscoveryFeedback = Boolean(
    discoveryError ||
    discoveryBlockedReason ||
    showFreshness ||
    showStartedMessage ||
    showNoOpenMessage,
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
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void onDiscover()}
            disabled={discoveryRefreshing || !ready}
            title={
              ready
                ? "Find staged npm publishes and start reviews"
                : "Connect a validated npm token in Settings → Integrations first"
            }
          >
            {discoveryRefreshing ? "Checking npm…" : "Check npm"}
          </Button>
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
          {discoveryBlockedReason ? (
            <Muted class="text-[13px] m-0">
              {discoveryBlockedReason}{" "}
              <a href="/dashboard/settings?tab=integrations" class="underline">
                Open settings
              </a>
              .
            </Muted>
          ) : null}
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
          <ScanTable
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
      <span class="w-[160px]">
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
    case "publish":
      return "No approved reviews yet.";
    case "no_publish":
      return "No blocked reviews yet.";
    default:
      return "No reviews yet. Check npm or wait for auto-discovery to find a staged release.";
  }
}

// Two different problems wear the same disabled button, and the fix differs:
// there is no token at all, or there is one npm has not accepted.
function npmConnectionBlockedReason(connection: { validationStatus: string } | null): string {
  return connection
    ? "Check npm is unavailable: the stored npm token has not validated. Revalidate it in Settings → Integrations."
    : "Check npm is unavailable until an npm token is connected in Settings → Integrations.";
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

function ScanTable({
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
    <div class="overflow-x-auto">
      <table class="w-full border-collapse text-[13px]">
        <thead>
          <tr class="border-b border-border bg-surface-2">
            <Th>Package</Th>
            <Th>Version</Th>
            <Th>Risk</Th>
            <Th>Changed</Th>
            <Th>Status</Th>
            <Th>Decision</Th>
            <Th>Actions</Th>
          </tr>
        </thead>
        <tbody>
          {scans.map((scan) => (
            <tr key={scan.id} class="border-b border-border last:border-b-0 hover:bg-surface-2">
              <Td>
                <span class="flex items-center gap-2 min-w-[180px]">
                  <a href={`/dashboard/scans/${encodeURIComponent(scan.id)}`}>
                    {scan.packageName || scan.stageId}
                  </a>
                  {scan.source === "workflow_gate" ? <Badge tone="neutral">gate</Badge> : null}
                </span>
              </Td>
              <Td class="font-mono text-xs text-ink-muted whitespace-nowrap">
                {scan.previousVersion || "—"} → {scan.stagedVersion || "—"}
              </Td>
              <Td>
                <ScanRiskCell scan={scan} />
              </Td>
              <Td>
                <ScanChangedCell scan={scan} />
              </Td>
              <Td>
                <ScanStatusBadge status={scan.status} />
              </Td>
              <Td>
                <div class="flex flex-wrap items-center gap-1.5">
                  <DecisionBadge decision={scan.decision} />
                  <RegistryStatusBadge scan={scan} />
                </div>
              </Td>
              <Td>
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
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function canQuickDecide(scan: ScanListItem): boolean {
  return (
    scan.status === "complete" &&
    scan.source !== "workflow_gate" &&
    scan.registryStatusSupersededAt == null
  );
}

function ScanRiskCell({ scan }: { scan: ScanListItem }) {
  if (scan.status !== "complete") {
    return <span class="font-mono text-xs text-ink-subtle">—</span>;
  }
  const releaseRisk = scan.riskSummary?.releaseRisk ?? scan.risk;
  return <Badge tone={severityTone(releaseRisk)}>{releaseRisk}</Badge>;
}

function ScanChangedCell({ scan }: { scan: ScanListItem }) {
  if (scan.status !== "complete") {
    return <span class="font-mono text-xs text-ink-subtle">—</span>;
  }
  const changedFiles = scan.changedFileCount ?? 0;
  return (
    <span class="font-mono text-xs text-ink-muted whitespace-nowrap">
      {changedFiles} {pluralize("file", changedFiles)}
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

function Th({ children }: { children: ComponentChildren }) {
  return (
    <th class="text-left font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle px-4 py-2.5">
      {children}
    </th>
  );
}

function Td({ children, class: className }: { children: ComponentChildren; class?: string }) {
  return <td class={`px-4 py-2.5 align-middle ${className || ""}`}>{children}</td>;
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
