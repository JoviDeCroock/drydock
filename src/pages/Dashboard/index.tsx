import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { useSignal, useModel, useSignalEffect } from "@preact/signals";
import { useLocation } from "preact-iso";
import { rememberDashboardReturnUrl, useQuerySignal } from "../../lib/query-state";
import { sessionModel } from "../../models/auth";
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
  Field,
  Input,
  LoadingState,
  MonoDetail,
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

  const activeOrganization = organizations.active.value;
  const canManageMembers = Boolean(activeOrganization && !activeOrganization.isPersonal);

  return (
    <PageShell
      headerActions={
        <>
          <OrgSwitcher
            organizations={organizations.organizations.value}
            activeOrganizationId={organizations.activeOrganizationId.value}
            busy={organizations.busy.value}
            error={organizations.error.value}
            onActivate={onSwitchOrganization}
            onCreate={onCreateOrganization}
            manageHref={canManageMembers ? "/dashboard/settings" : undefined}
          />
          <UserMenu email={user?.email} name={user?.name} onSignOut={onSignOut} />
        </>
      }
    >
      <DashboardHeader />

      {workspaceLoaded ? (
        <>
          <RecentReviewsSection scans={scans} stagedPublishes={stagedPublishes} npm={npm} />
          <WorkspaceSetupPanel npm={npm} />
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
        Bring a staged npm publish into drydock, compare it with the live version, and leave with a
        focused safety brief before maintainers approve.
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
  const ready = npm.validated.value;
  const discovery = stagedPublishes.lastResult.value;
  const discoveryError = stagedPublishes.error.value;
  const discoveryRefreshing = stagedPublishes.refreshing.value;
  const startedLabels = discovery?.scans.map(formatStartedScanLabel).filter(Boolean) ?? [];
  const onDiscover = async () => {
    await discoverStagedPublishes(stagedPublishes, scans);
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

function WorkspaceSetupPanel({
  npm,
}: {
  npm: ReturnType<typeof useModel<typeof NpmConnectionModel.prototype>>;
}) {
  const connection = npm.connection.value;
  return (
    <section id="workspace-setup" class="scroll-mt-6">
      <Card as="div" class="p-0 overflow-hidden">
        <details open={!connection} class="group">
          <summary class="list-none cursor-pointer px-5 py-4 transition-colors duration-150 ease-out hover:bg-surface-2 group-open:border-b group-open:border-border">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="flex flex-col gap-1.5 min-w-0">
                <SectionLabel>Workspace setup</SectionLabel>
                <Muted class="text-[13px] m-0">
                  Manage npm access, credential checks, and workspace safety defaults.
                </Muted>
                <MonoDetail
                  parts={[
                    <span key="connection">npm {connection ? "connected" : "not connected"}</span>,
                    <span key="evidence">redacted evidence</span>,
                    <span key="approval">human approval</span>,
                  ]}
                />
              </div>
              <div class="flex flex-wrap items-center justify-end gap-2">
                <Badge tone={connection ? "ok" : "info"}>
                  {connection ? connection.validationStatus : "connect npm"}
                </Badge>
                <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
                  <span class="group-open:hidden">open settings</span>
                  <span class="hidden group-open:inline">close settings</span>
                </span>
              </div>
            </div>
          </summary>
          <div class="p-5">
            <NpmConnectionCard npm={npm} />
          </div>
        </details>
      </Card>
    </section>
  );
}

function NpmConnectionCard({
  npm,
}: {
  npm: ReturnType<typeof useModel<typeof NpmConnectionModel.prototype>>;
}) {
  const connection = npm.connection.value;
  const status = npm.status.value;
  const busy = npm.busy.value;
  const validated = npm.validated.value;
  const token = npm.token.value;
  const label = npm.label.value;
  const registry = npm.registry.value;
  const validationStageId = npm.validationStageId.value;
  const error = npm.error.value;

  const onSave = async (event: Event) => {
    event.preventDefault();
    await npm.save();
  };

  return (
    <div class="flex flex-col gap-5">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex flex-col gap-1.5">
          <SectionLabel>npm access</SectionLabel>
          <Muted class="text-[13px] max-w-[760px]">
            Add an organization npm token so reviews can fetch staged packages securely. We encrypt
            it, hide it after save, and use it only to retrieve release evidence.
          </Muted>
        </div>
        {connection ? (
          <Badge
            tone={
              validated ? "ok" : connection.validationStatus === "invalid" ? "critical" : "info"
            }
          >
            {connection.validationStatus}
          </Badge>
        ) : (
          <Badge tone="info">not connected</Badge>
        )}
      </div>

      {connection ? (
        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-x-6 gap-y-2 border-y border-border py-3">
          <CompactMetadataRow label="label" value={connection.label} />
          <CompactMetadataRow label="registry" value={connection.registryUrl} />
          <CompactMetadataRow label="token" value={`•••• ${connection.tokenLast4 || "stored"}`} />
          <CompactMetadataRow
            label="validated"
            value={connection.validatedAt ? formatDate(connection.validatedAt) : "not yet"}
          />
          <CompactMetadataRow
            label="last used"
            value={connection.lastUsedAt ? formatDate(connection.lastUsedAt) : "never"}
          />
        </div>
      ) : null}

      <form
        class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.5fr)_auto] gap-3 items-end"
        onSubmit={onSave}
      >
        <Field label="Connection name" for="npmLabel">
          <Input
            id="npmLabel"
            type="text"
            value={label}
            onInput={(e) => (npm.label.value = (e.target as HTMLInputElement).value)}
            disabled={busy}
          />
        </Field>
        <Field label="Registry" for="npmRegistry">
          <Input
            id="npmRegistry"
            type="url"
            value={registry}
            onInput={(e) => (npm.registry.value = (e.target as HTMLInputElement).value)}
            disabled={busy}
          />
        </Field>
        <Field label={connection ? "New npm token" : "npm token"} for="npmToken">
          <Input
            id="npmToken"
            type="password"
            value={token}
            placeholder={connection ? "Paste a new token to rotate" : "npm_..."}
            onInput={(e) => (npm.token.value = (e.target as HTMLInputElement).value)}
            disabled={busy}
            autoComplete="off"
            spellcheck={false}
          />
        </Field>
        <Button type="submit" disabled={busy || !token.trim()} class="shrink-0">
          {status === "saving"
            ? "Saving…"
            : status === "validating"
              ? "Checking…"
              : connection
                ? "Rotate"
                : "Save"}
        </Button>
      </form>

      <div class="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto] gap-3 items-end">
        <Field label="Stage ID access check" for="validationStageId">
          <Input
            id="validationStageId"
            type="text"
            value={validationStageId}
            placeholder="Paste a real stage ID to confirm package access"
            onInput={(e) => (npm.validationStageId.value = (e.target as HTMLInputElement).value)}
            disabled={busy || !connection}
            autoComplete="off"
            spellcheck={false}
          />
        </Field>
        <Button
          variant="secondary"
          onClick={() => void npm.validate()}
          disabled={busy || !connection}
          class="shrink-0"
        >
          {status === "validating"
            ? "Checking…"
            : validationStageId.trim()
              ? "Check stage access"
              : "Check npm auth"}
        </Button>
      </div>

      <Muted class="text-xs">
        Saving runs the npm auth check automatically. Add a stage ID to prove the token can read
        that staged release; we do not keep the release archive.
      </Muted>

      {error ? <Alert tone="critical">{error}</Alert> : null}

      {connection ? (
        <div class="flex justify-end border-t border-border pt-4">
          <Button variant="danger" size="sm" onClick={() => void npm.remove()} disabled={busy}>
            {status === "deleting" ? "Removing…" : "Disconnect npm"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function CompactMetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div class="grid grid-cols-[92px_minmax(0,1fr)] gap-3 text-[13px] min-w-0">
      <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">{label}</span>
      <code class="text-xs text-ink-muted break-all">{value}</code>
    </div>
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
                <a
                  href={`/dashboard/scans/${encodeURIComponent(scan.id)}`}
                  class="min-w-[180px] inline-block"
                >
                  {scan.packageName || scan.stageId}
                </a>
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

function formatDate(value: string | number | Date | null | undefined) {
  if (value === null || value === undefined) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function pluralize(word: string, count: number) {
  return count === 1 ? word : `${word}s`;
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
