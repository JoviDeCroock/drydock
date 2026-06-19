import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import {
  useComputed,
  useSignal,
  useModel,
  useSignalEffect,
  type ReadonlySignal,
  type Signal,
} from "@preact/signals";
import { For, Show, useLiveSignal } from "@preact/signals/utils";
import { useLocation } from "preact-iso";
import { rememberDashboardReturnUrl, useQuerySignal } from "../../lib/query-state";
import { npmStagedPackagesUrlFor } from "../../lib/npm-staged-url";
import { pluralize } from "../../lib/format";
import { sessionModel } from "../../models/auth";
import { NpmConnectionModel } from "../../models/npm-connection";
import { OrganizationModel } from "../../models/organization";
import {
  ScanListModel,
  type ScanDecision,
  type ScanDecisionFilter,
  type ScanListItem,
} from "../../models/scan";
import { StagedPublishesModel } from "../../models/staged-publishes";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyLine,
  Eyebrow,
  LinkButton,
  LoadingState,
  Muted,
  OrgSwitcher,
  PageShell,
  SectionLabel,
  Select,
  UserMenu,
  severityTone,
} from "../../components";
import { DecisionDialog } from "./ScanDetail/DecisionDialog";

export default function DashboardPage() {
  const location = useLocation();
  const scans = useModel(ScanListModel);
  const npm = useModel(NpmConnectionModel);
  const organizations = useModel(OrganizationModel);
  const stagedPublishes = useModel(StagedPublishesModel);
  const sessionChecked = useSignal(false);
  const workspaceLoaded = useComputed(() => scans.loaded.value && npm.loaded.value);
  const workspaceLoadingDetail = useComputed(() => {
    const scansLoaded = scans.loaded.value;
    const npmLoaded = npm.loaded.value;
    return npmLoaded
      ? "fetching recent reviews"
      : scansLoaded
        ? "checking npm connection"
        : "loading reviews · checking npm connection";
  });
  const needsNpmSetup = useComputed(() => !npm.connection.value);

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

      <Show
        when={workspaceLoaded}
        fallback={<WorkspaceLoadingState detail={workspaceLoadingDetail} />}
      >
        <>
          <Show when={needsNpmSetup}>
            <NpmSetupCallout />
          </Show>
          <RecentReviewsSection scans={scans} stagedPublishes={stagedPublishes} npm={npm} />
        </>
      </Show>
    </PageShell>
  );
}

function WorkspaceLoadingState({ detail }: { detail: ReadonlySignal<string> }) {
  return <LoadingState title="Loading workspace" detail={detail.value} />;
}

function DashboardHeader() {
  return (
    <header class="flex flex-col gap-2 max-w-[640px]">
      <Eyebrow>Review workspace</Eyebrow>
      <h1 class="text-3xl font-semibold tracking-[-0.02em] m-0">Ready for the next release</h1>
      <Muted class="text-[14px] leading-[1.55] m-0">
        Review held npm and PyPI candidates before maintainers let them go live.
      </Muted>
    </header>
  );
}

async function discoverStagedPublishes(
  stagedPublishes: ReturnType<typeof useModel<typeof StagedPublishesModel.prototype>>,
  scans: ReturnType<typeof useModel<typeof ScanListModel.prototype>>,
) {
  await stagedPublishes.discover();
  await scans.refresh();
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
  const quickDecisionScan = useSignal<ScanListItem | null>(null);
  const discoverDisabled = useComputed(
    () => stagedPublishes.refreshing.value || !npm.validated.value,
  );
  const freshnessAt = useComputed(() => {
    const discoveredAt = stagedPublishes.lastDiscoveryAt.value;
    const discoveryError = stagedPublishes.error.value;
    const discoveryRefreshing = stagedPublishes.refreshing.value;
    return discoveredAt !== null && !discoveryError && !discoveryRefreshing ? discoveredAt : null;
  });
  const discoveryStartedMessage = useComputed(() => {
    const discovery = stagedPublishes.lastResult.value;
    const discoveryError = stagedPublishes.error.value;
    if (!discovery || discoveryError || !discovery.created) return null;
    const startedLabels = discovery.scans.map(formatStartedScanLabel).filter(Boolean);
    return `Started ${discovery.created} new review${discovery.created === 1 ? "" : "s"} from npm${
      startedLabels.length ? `: ${startedLabels.slice(0, 3).join(", ")}` : ""
    }${startedLabels.length > 3 ? `, +${startedLabels.length - 3} more` : ""}.`;
  });
  const noOpenPublishes = useComputed(() => {
    const discovery = stagedPublishes.lastResult.value;
    const discoveryError = stagedPublishes.error.value;
    return Boolean(discovery && !discoveryError && !discovery.created && !discovery.found);
  });
  const showDiscoveryFeedback = useComputed(
    () =>
      Boolean(stagedPublishes.error.value) ||
      freshnessAt.value !== null ||
      Boolean(discoveryStartedMessage.value) ||
      noOpenPublishes.value,
  );
  const hasScans = useComputed(() => scans.scans.value.length > 0);
  const emptyMessage = useComputed(() => emptyStateMessage(scans.filter.value));
  const quickDecisionScanId = useComputed(() => quickDecisionScan.value?.id ?? null);
  const decisionSaving = useComputed(() => scans.decisionStatus.value === "saving");
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

  return (
    <Card as="section" padding="none" class="overflow-hidden">
      <div class="px-5 py-4 flex flex-col gap-3 md:flex-row md:items-center">
        <SectionLabel class="flex-1 min-w-0 after:hidden">Recent reviews</SectionLabel>
        <div class="flex flex-wrap items-center gap-2 shrink-0">
          <ScanStateSelect
            value={scans.filter}
            disabled={scans.refreshing}
            onChange={(filter) => (scans.filter.value = filter)}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void onDiscover()}
            disabled={discoverDisabled}
            title="Find staged npm publishes and start reviews"
          >
            <Show when={stagedPublishes.refreshing} fallback="Check npm">
              Checking npm…
            </Show>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void scans.refresh()}
            disabled={scans.refreshing}
            title="Reload the reviews list"
          >
            <Show when={scans.refreshing} fallback="Refresh">
              Refreshing…
            </Show>
          </Button>
        </div>
      </div>
      <Show when={showDiscoveryFeedback}>
        <div class="px-5 pb-4 flex flex-col gap-2">
          <Show<string | null> when={stagedPublishes.error}>
            {(message) => <Alert tone="critical">{message}</Alert>}
          </Show>
          <Show when={freshnessAt}>{(at) => <ScanFreshnessIndicator at={at} />}</Show>
          <Show<string | null> when={discoveryStartedMessage}>
            {(message) => <Muted class="text-[13px] m-0">{message}</Muted>}
          </Show>
          <Show when={noOpenPublishes}>
            <Muted class="text-[13px] m-0">No open staged publishes found.</Muted>
          </Show>
        </div>
      </Show>
      <div class="border-t border-border">
        <Show
          when={hasScans}
          fallback={
            <div class="p-5">
              <EmptyLine>{emptyMessage}</EmptyLine>
            </div>
          }
        >
          <ScanTable
            scans={scans.scans}
            quickDecisionScanId={quickDecisionScanId}
            decisionSaving={decisionSaving}
            onQuickDecide={(scan) => {
              scans.decisionError.value = null;
              quickDecisionScan.value = scan;
            }}
          />
        </Show>
      </div>
      <Show when={scans.nextCursor}>
        <div class="border-t border-border px-5 py-4 flex justify-center">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void scans.loadMore()}
            disabled={scans.loadingMore}
          >
            <Show when={scans.loadingMore} fallback="Load more">
              Loading…
            </Show>
          </Button>
        </div>
      </Show>
      <Show<ScanListItem | null> when={quickDecisionScan}>
        {(scan) => (
          <QuickDecisionDialog
            scan={scan}
            scans={scans}
            quickDecisionScan={quickDecisionScan}
            onSubmit={onQuickDecisionSubmit}
          />
        )}
      </Show>
    </Card>
  );
}

function QuickDecisionDialog({
  scan,
  scans,
  quickDecisionScan,
  onSubmit,
}: {
  scan: ScanListItem;
  scans: ReturnType<typeof useModel<typeof ScanListModel.prototype>>;
  quickDecisionScan: Signal<ScanListItem | null>;
  onSubmit: (decision: ScanDecision, reason: string | null) => boolean | Promise<boolean>;
}) {
  return (
    <DecisionDialog
      open={true}
      onClose={() => (quickDecisionScan.value = null)}
      decision={scan.decision}
      decisionReason={scan.decisionReason}
      decidedAt={scan.decidedAt}
      status={scans.decisionStatus.value}
      error={scans.decisionError.value}
      npmStagedPackagesUrl={npmStagedPackagesUrlFor(scan)}
      onSubmit={onSubmit}
    />
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
  value: Signal<ScanDecisionFilter>;
  disabled: ReadonlySignal<boolean>;
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

function emptyStateMessage(filter: ScanDecisionFilter): string {
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

function formatStartedScanLabel(scan: { packageName: string | null; version: string | null }) {
  if (scan.packageName && scan.version) return `${scan.packageName}@${scan.version}`;
  return scan.packageName || scan.version || null;
}

function NpmSetupCallout() {
  return (
    <Card as="section" class="p-5 flex flex-wrap items-center justify-between gap-3">
      <div class="flex flex-col gap-1.5 min-w-0">
        <SectionLabel>npm not connected</SectionLabel>
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
  onQuickDecide,
}: {
  scans: ReadonlySignal<ScanListItem[]>;
  quickDecisionScanId: ReadonlySignal<string | null>;
  decisionSaving: ReadonlySignal<boolean>;
  onQuickDecide: (scan: ScanListItem) => void;
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
          </tr>
        </thead>
        <tbody>
          <For each={scans}>
            {(scan) => (
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
                  <div class="flex flex-wrap items-center gap-2">
                    <DecisionBadge decision={scan.decision} />
                    <Show when={() => canQuickDecide(scan)}>
                      <QuickDecisionButton
                        scan={scan}
                        quickDecisionScanId={quickDecisionScanId}
                        decisionSaving={decisionSaving}
                        onQuickDecide={onQuickDecide}
                      />
                    </Show>
                  </div>
                </Td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}

function QuickDecisionButton({
  scan,
  quickDecisionScanId,
  decisionSaving,
  onQuickDecide,
}: {
  scan: ScanListItem;
  quickDecisionScanId: ReadonlySignal<string | null>;
  decisionSaving: ReadonlySignal<boolean>;
  onQuickDecide: (scan: ScanListItem) => void;
}) {
  const variant = scan.decision ? "secondary" : "primary";
  const label = useComputed(() => {
    if (decisionSaving.value && quickDecisionScanId.value === scan.id) return "Saving…";
    return scan.decision ? "Update" : "Decide";
  });
  return (
    <Button
      variant={variant}
      size="sm"
      onClick={() => onQuickDecide(scan)}
      disabled={decisionSaving}
      title="Record a decision without leaving the dashboard"
    >
      {label}
    </Button>
  );
}

function canQuickDecide(scan: ScanListItem): boolean {
  return scan.status === "complete" && scan.source !== "workflow_gate";
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
  const liveAt = useLiveSignal(at);
  const now = useSignal(Date.now());
  const label = useComputed(() => `checked ${formatRelativeTime(liveAt.value, now.value)}`);
  useEffect(() => {
    const id = window.setInterval(() => {
      now.value = Date.now();
    }, 30_000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span class="font-mono text-[11px] text-ink-subtle whitespace-nowrap select-none">{label}</span>
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
