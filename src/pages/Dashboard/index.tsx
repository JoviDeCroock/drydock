import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { useSignal, useModel, useSignalEffect } from "@preact/signals";
import { useLocation } from "preact-iso";
import { rememberDashboardReturnUrl, useQuerySignal } from "../../lib/query-state";
import { pluralize } from "../../lib/format";
import { sessionModel } from "../../models/auth";
import {
  IntegrationHealthModel,
  type IntegrationHealthIssue,
} from "../../models/integration-health";
import { NpmConnectionModel } from "../../models/npm-connection";
import { OrganizationModel } from "../../models/organization";
import { ScanListModel, type ScanDecisionFilter, type ScanListItem } from "../../models/scan";
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
  UserMenu,
  severityTone,
} from "../../components";

export default function DashboardPage() {
  const location = useLocation();
  const scans = useModel(ScanListModel);
  const npm = useModel(NpmConnectionModel);
  const organizations = useModel(OrganizationModel);
  const stagedPublishes = useModel(StagedPublishesModel);
  const integrationHealth = useModel(IntegrationHealthModel);
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
      await Promise.all([
        organizations.load(),
        scans.refresh(),
        npm.load(),
        integrationHealth.load(),
      ]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onSwitchOrganization = async (organizationId: string) => {
    if (organizations.activate(organizationId)) {
      await Promise.all([scans.refresh(), npm.load(), integrationHealth.load()]);
    }
  };

  const onCreateOrganization = async (name: string) => {
    const created = await organizations.create(name);
    if (created) {
      await Promise.all([scans.refresh(), npm.load(), integrationHealth.load()]);
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
        <LoadingState
          title="Opening workspace"
          detail="confirming session · fetching recent reviews"
        />
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
          <IntegrationHealthBanner issues={integrationHealth.issues.value} />
          {!npm.connection.value ? <NpmSetupCallout /> : null}
          <RecentReviewsSection
            scans={scans}
            stagedPublishes={stagedPublishes}
            npm={npm}
            integrationHealth={integrationHealth}
          />
        </>
      ) : (
        <LoadingState
          title="Loading workspace"
          detail={
            npmLoaded
              ? "fetching recent reviews"
              : scansLoaded
                ? "checking npm connection"
                : "fetching recent reviews · checking npm connection"
          }
        />
      )}
    </PageShell>
  );
}

function DashboardHeader() {
  return (
    <header class="flex flex-col gap-2 max-w-[640px]">
      <Eyebrow>Review workspace</Eyebrow>
      <h1 class="text-3xl font-semibold tracking-[-0.02em] m-0">Ready for the next release</h1>
      <Muted class="text-[14px] leading-[1.55] m-0">
        Diff a staged npm publish against the live version before maintainers approve.
      </Muted>
    </header>
  );
}

async function discoverStagedPublishes(
  stagedPublishes: ReturnType<typeof useModel<typeof StagedPublishesModel.prototype>>,
  scans: ReturnType<typeof useModel<typeof ScanListModel.prototype>>,
  npm: ReturnType<typeof useModel<typeof NpmConnectionModel.prototype>>,
  integrationHealth: ReturnType<typeof useModel<typeof IntegrationHealthModel.prototype>>,
) {
  await stagedPublishes.discover();
  await Promise.all([scans.refresh(), npm.load(), integrationHealth.load()]);
}

function RecentReviewsSection({
  scans,
  stagedPublishes,
  npm,
  integrationHealth,
}: {
  scans: ReturnType<typeof useModel<typeof ScanListModel.prototype>>;
  stagedPublishes: ReturnType<typeof useModel<typeof StagedPublishesModel.prototype>>;
  npm: ReturnType<typeof useModel<typeof NpmConnectionModel.prototype>>;
  integrationHealth: ReturnType<typeof useModel<typeof IntegrationHealthModel.prototype>>;
}) {
  const ready = npm.validated.value;
  const discovery = stagedPublishes.lastResult.value;
  const discoveryError = stagedPublishes.error.value;
  const discoveryRefreshing = stagedPublishes.refreshing.value;
  const startedLabels = discovery?.scans.map(formatStartedScanLabel).filter(Boolean) ?? [];
  const onDiscover = async () => {
    await discoverStagedPublishes(stagedPublishes, scans, npm, integrationHealth);
  };

  const discoveredAt = stagedPublishes.lastDiscoveryAt.value;
  const showFreshness = discoveredAt !== null && !discoveryError && !discoveryRefreshing;

  return (
    <section class="flex flex-col gap-3">
      <div class="flex items-center gap-3">
        <SectionLabel class="flex-1 min-w-0">Recent reviews</SectionLabel>
        <div class="flex items-center gap-2 shrink-0">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void onDiscover()}
            disabled={discoveryRefreshing || !ready}
          >
            {discoveryRefreshing ? "Checking…" : "Check npm"}
          </Button>
          {showFreshness ? <ScanFreshnessIndicator at={discoveredAt} /> : null}
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void scans.refresh()}
          class="shrink-0"
          disabled={scans.refreshing.value}
        >
          {scans.refreshing.value ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {discoveryError ? <Alert tone="critical">{discoveryError}</Alert> : null}
      {discovery && !discoveryError && discovery.created ? (
        <Muted class="text-[13px] m-0">
          {`Started ${discovery.created} new review${discovery.created === 1 ? "" : "s"} from npm${
            startedLabels.length ? `: ${startedLabels.slice(0, 3).join(", ")}` : ""
          }${startedLabels.length > 3 ? `, +${startedLabels.length - 3} more` : ""}.`}
        </Muted>
      ) : null}
      {discovery && !discoveryError && !discovery.created && !discovery.found ? (
        <Muted class="text-[13px] m-0">No open staged publishes found.</Muted>
      ) : null}
      <ScanFilterChips
        active={scans.filter.value}
        disabled={scans.refreshing.value}
        onChange={(filter) => (scans.filter.value = filter)}
      />
      <Card class="p-0 overflow-hidden">
        {scans.scans.value.length ? (
          <ScanTable scans={scans.scans.value} />
        ) : (
          <div class="p-5">
            <EmptyLine>{emptyStateMessage(scans.filter.value)}</EmptyLine>
          </div>
        )}
      </Card>
      {scans.nextCursor.value ? (
        <div class="flex justify-center pt-1">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void scans.loadMore()}
            disabled={scans.loadingMore.value}
          >
            {scans.loadingMore.value ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </section>
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

function ScanFilterChips({
  active,
  disabled,
  onChange,
}: {
  active: ScanDecisionFilter;
  disabled: boolean;
  onChange: (filter: ScanDecisionFilter) => void;
}) {
  return (
    <div class="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter reviews by decision">
      {FILTER_OPTIONS.map((option) => {
        const isActive = option.value === active;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            class={`font-mono text-[11px] uppercase tracking-[0.08em] px-2.5 py-1.5 rounded-md border transition-colors duration-150 ease-out cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 ${
              isActive
                ? "bg-accent text-accent-on border-accent"
                : "bg-surface-2 text-ink-muted border-border hover:border-border-strong"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function emptyStateMessage(filter: ScanDecisionFilter): string {
  switch (filter) {
    case "undecided":
      return "Nothing waiting on a decision. Switch to All to see decided reviews.";
    case "publish":
      return "No reviews approved for publish yet.";
    case "no_publish":
      return "No reviews blocked from publish yet.";
    default:
      return "No reviews yet. Check npm or wait for auto-discovery to surface staged releases.";
  }
}

function formatStartedScanLabel(scan: { packageName: string | null; version: string | null }) {
  if (scan.packageName && scan.version) return `${scan.packageName}@${scan.version}`;
  return scan.packageName || scan.version || null;
}

function IntegrationHealthBanner({ issues }: { issues: IntegrationHealthIssue[] }) {
  if (!issues.length) return null;
  return (
    <div class="flex flex-col gap-2">
      {issues.map((issue, index) => (
        <Alert
          key={`${issue.kind}-${index}`}
          tone={issue.severity === "critical" ? "critical" : "warn"}
        >
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex flex-col gap-0.5 min-w-0">
              <strong class="text-[13px]">{issue.title}</strong>
              <span class="text-[13px] text-ink-muted">{issue.detail}</span>
            </div>
            <LinkButton variant="secondary" size="sm" href="/dashboard/settings">
              Open settings
            </LinkButton>
          </div>
        </Alert>
      ))}
    </div>
  );
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
      <LinkButton variant="primary" size="sm" href="/dashboard/settings">
        Open settings
      </LinkButton>
    </Card>
  );
}

function ScanTable({ scans }: { scans: ScanListItem[] }) {
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
              <Td class="font-mono text-xs text-ink-muted">{scan.status}</Td>
              <Td>
                <DecisionBadge decision={scan.decision} />
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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

function DecisionBadge({ decision }: { decision?: string | null }) {
  if (decision === "publish") return <Badge tone="ok">approved</Badge>;
  if (decision === "no_publish") return <Badge tone="critical">blocked</Badge>;
  return <Badge tone="neutral">undecided</Badge>;
}

function Th({ children }: { children: ComponentChildren }) {
  return (
    <th class="text-left font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle px-4 py-2.5">
      {children}
    </th>
  );
}

function Td({ children, class: className }: { children: ComponentChildren; class?: string }) {
  return <td class={`px-4 py-2.5 align-middle ${className || ""}`}>{children}</td>;
}

function ScanFreshnessIndicator({ at }: { at: number }) {
  const now = useSignal(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => {
      now.value = Date.now();
    }, 30_000);
    return () => window.clearInterval(id);
  }, []);
  const label = `scanned ${formatRelativeTime(at, now.value)}`;
  return (
    <span
      class="font-mono text-[14px] leading-none text-ok cursor-help select-none"
      title={label}
      aria-label={label}
    >
      ✓
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
