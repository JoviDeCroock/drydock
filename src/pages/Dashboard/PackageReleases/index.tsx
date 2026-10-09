/**
 * One package's reviewed releases, grouped by channel (dist-tag), newest
 * first. Where the dashboard answers "what is waiting for me", this page
 * answers "what has shipped under this name, on which channel, and did npm's
 * outcome agree with ours" — the per-package, per-channel question npm's
 * multiple trusted-publishing configurations make maintainers ask.
 */
import { Fragment, type ComponentChildren } from "preact";
import { type ReadonlySignal, useComputed, useModel, useSignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { useLocation, useRoute } from "preact-iso";
import { ecosystemLabel } from "../../../../server/lib/ecosystems/labels";
import { formatDateTime, pluralize } from "../../../lib/format";
import { AppHeaderActions } from "../../../features/account/AppHeaderActions";
import { useAuthedDashboardSession } from "../../../features/account/useAuthedDashboardSession";
import { usePinnedOrganization } from "../../../features/account/usePinnedOrganization";
import { packageReleasesPath } from "../../../lib/package-releases-path";
import { scanDetailPath } from "../../../lib/scan-detail-path";
import { OrganizationModel } from "../../../models/organization";
import {
  PackageReleasesModel,
  type PackageRelease,
  type PackageReleasesResponse,
} from "../../../models/package-releases";
import { Alert } from "../../../components/Alert";
import { Badge, severityTone } from "../../../components/Badge";
import { LoadMoreButton } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { LoadingState } from "../../../components/Loading";
import { PageShell } from "../../../components/PageShell";
import { EmptyLine, MonoDetail, SectionLabel } from "../../../components/Typography";
import {
  channelLabel,
  describeAttentionCounts,
  describeBaseline,
  groupReleasesByChannel,
  releaseAttention,
} from "../../../features/package-releases";
import { registryStatusBadge } from "../../../features/registry-status";
import { DecisionState } from "../../../features/review/DecisionState";
import { scanSourceLabel } from "../../../features/scan-source";
import { PackageManagement } from "../../../features/package-claims/PackageManagement";
import { PackagePublicationSection } from "../../../features/publication-monitor/PackagePublicationSection";
import { PackageClaimModel } from "../../../models/package-claim";
import { PUBLIC_ECOSYSTEMS, type PublicEcosystem } from "../../../../server/lib/public-feed";
import { PublicBadgeSection } from "./PublicBadgeSection";

export default function PackageReleasesPage() {
  const location = useLocation();
  const route = useRoute();
  const packageName = route.params.name ?? "";
  const ecosystem = location.query.ecosystem || "npm";
  // The page is one organization's history, so the organization is part of
  // its address: `?org=` is kept, and every request on the page carries it.
  const organizationId = location.query.org || null;
  usePinnedOrganization(organizationId);
  // The model is built once per mount, so a navigation from one package page
  // straight to another (or to another organization's) must remount rather
  // than reuse a model bound to the previous name.
  return (
    <PackageReleasesView
      key={`${organizationId ?? ""}:${ecosystem}:${packageName}`}
      packageName={packageName}
      ecosystem={ecosystem}
      organizationId={organizationId}
    />
  );
}

function PackageReleasesView({
  packageName,
  ecosystem,
  organizationId,
}: {
  packageName: string;
  ecosystem: string;
  organizationId: string | null;
}) {
  const location = useLocation();
  const model = useModel(() => new PackageReleasesModel(packageName, ecosystem));
  const organizations = useModel(OrganizationModel);
  const personalWorkspace = useComputed(() => organizations.active.value?.isPersonal === true);
  const membership = useSignal<"resolving" | "member" | "not_member" | "unavailable">("resolving");
  const sessionChecked = useAuthedDashboardSession({
    onReady: async (_session, isCancelled) => {
      await organizations.load();
      if (isCancelled()) return;
      // Without the membership list an outage would read as "not a member";
      // report the failed load instead of guessing.
      if (organizations.error.peek()) {
        membership.value = "unavailable";
        return;
      }
      if (!organizationId) {
        // An address without an organization would show whichever one this
        // browser had active; name it in the URL before reading anything.
        const active = organizations.active.peek();
        if (active) location.route(packageReleasesPath(packageName, ecosystem, active.id), true);
        return;
      }
      if (!organizations.organizations.peek().some((org) => org.id === organizationId)) {
        membership.value = "not_member";
        return;
      }
      membership.value = "member";
      await model.load();
    },
  });

  const channels = useComputed(() => groupReleasesByChannel(model.releases.value));
  const ready = useComputed(
    () => sessionChecked.value && membership.value === "member" && model.loaded.value,
  );
  const hasReleases = useComputed(() => model.releases.value.length > 0);
  const organizationName = useComputed(() =>
    membership.value === "member" ? (organizations.active.value?.name ?? null) : null,
  );

  const organizationLabel = useComputed(() => organizationName.value ?? "this organization");

  const openInOrganization = (id: string) => {
    if (organizations.activate(id)) {
      location.route(packageReleasesPath(packageName, ecosystem, id));
    }
  };
  const onCreateOrganization = async (name: string) => {
    const created = await organizations.create(name);
    if (created) location.route(packageReleasesPath(packageName, ecosystem, created.id));
  };

  // The releases slot only; a package with no reviews here leads the page
  // with its empty state instead, so the sections below cannot read as
  // describing some history this organization has.
  const releases = (
    <Show when={hasReleases}>
      {() => (
        <div class="flex flex-col gap-6">
          {channels.value.map((channel) => (
            <ChannelSection
              key={channel.tag ?? ""}
              tag={channel.tag}
              releases={channel.releases}
              organizationId={organizationId}
            />
          ))}
          <Show when={model.nextCursor}>
            {() => (
              <div class="flex justify-center">
                <LoadMoreButton
                  loading={model.loadingMore}
                  label="Load older releases"
                  onClick={() => void model.loadMore()}
                />
              </div>
            )}
          </Show>
        </div>
      )}
    </Show>
  );

  return (
    <PageShell
      headerActions={
        <AppHeaderActions
          current="reviews"
          organizations={organizations}
          onActivate={openInOrganization}
          onCreate={onCreateOrganization}
        />
      }
    >
      <header class="flex flex-col gap-2 min-w-0">
        <a href="/dashboard" class="text-[13px] text-ink-muted hover:text-ink no-underline">
          ← Reviews
        </a>
        <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0 break-words">{packageName}</h1>
        <PackageDetailLine
          model={model}
          ecosystem={ecosystem}
          organizationName={organizationName}
        />
      </header>

      <Show when={() => membership.value === "not_member"}>
        {() => (
          <Alert tone="critical">
            You are not a member of the organization this link names, so its history of{" "}
            {packageName} is not shown. Pick one of your organizations from the switcher to see
            yours.
          </Alert>
        )}
      </Show>
      <Show when={() => (membership.value === "unavailable" ? organizations.error.value : null)}>
        {(message) => <Alert tone="critical">{message}</Alert>}
      </Show>
      <Show when={model.error}>{(message) => <Alert tone="critical">{message}</Alert>}</Show>

      <Show
        when={ready}
        fallback={
          <Show when={() => membership.value === "resolving" || membership.value === "member"}>
            <LoadingState title="Loading releases" detail="confirming session · reading reviews" />
          </Show>
        }
      >
        {() => (
          <>
            <Show when={model.summary}>{(summary) => <AttentionAlert summary={summary} />}</Show>
            <Show when={() => !hasReleases.value}>
              <Card>
                <EmptyLine>
                  No {ecosystemLabel(ecosystem)} releases of {packageName} have been reviewed in{" "}
                  {organizationLabel} yet. Reviews start from the dashboard once a staged publish or
                  a gated release reaches Drydock.
                </EmptyLine>
              </Card>
            </Show>
            {ecosystem === "npm" ? (
              <NpmPackageSections
                packageName={packageName}
                personalWorkspace={personalWorkspace}
                onManagementChanged={() => void model.load()}
              >
                {releases}
              </NpmPackageSections>
            ) : (
              <>
                {PUBLIC_ECOSYSTEMS.includes(ecosystem as PublicEcosystem) ? (
                  <PublicBadgeSection
                    packageName={packageName}
                    ecosystem={ecosystem as PublicEcosystem}
                  />
                ) : null}
                {releases}
              </>
            )}
          </>
        )}
      </Show>
    </PageShell>
  );
}

// The package's facts as the page's mono detail line. Channel names and each
// channel's rows are the sections below, so the line only counts them.
function PackageDetailLine({
  model,
  ecosystem,
  organizationName,
}: {
  model: InstanceType<typeof PackageReleasesModel>;
  ecosystem: string;
  // The page is pinned to one organization by its address; naming it here is
  // what keeps a history from reading as some other organization's.
  organizationName: ReadonlySignal<string | null>;
}) {
  const parts = useComputed(() => {
    const summary = model.summary.value;
    const organization = organizationName.value;
    // With nothing reviewed, "0 reviews · 0 channels" would only restate the
    // empty state below it.
    if (!summary?.totalReviews) return [ecosystemLabel(ecosystem), organization];
    const { totalReviews, channels, lastRelease } = summary;
    return [
      ecosystemLabel(ecosystem),
      organization,
      `${totalReviews} ${pluralize("review", totalReviews)}`,
      `${channels.length} ${pluralize("channel", channels.length)}`,
      lastRelease
        ? `last ${lastRelease.version ?? "—"} ${formatDateTime(lastRelease.createdAt)}`
        : null,
    ];
  });
  return <MonoDetail parts={parts.value} />;
}

// Only the disagreements with npm earn space above the table, and only when
// there are some; the rows they count carry the matching fill and npm label.
function AttentionAlert({ summary }: { summary: PackageReleasesResponse["summary"] }) {
  const attention = describeAttentionCounts(summary);
  return attention ? <Alert tone={attention.tone}>{attention.text}</Alert> : null;
}

function ChannelSection({
  tag,
  releases,
  organizationId,
}: {
  tag: string | null;
  releases: PackageRelease[];
  organizationId: string | null;
}) {
  return (
    <section class="flex flex-col gap-3">
      <SectionLabel as="h2">
        {tag ? (
          <>
            channel <span class="text-ink normal-case tracking-normal">{tag}</span>
          </>
        ) : (
          channelLabel(tag)
        )}
      </SectionLabel>
      <Card padding="none" class="overflow-x-auto">
        <table class="w-full border-collapse text-[13px]">
          <thead>
            <tr class="border-b border-border bg-surface-2">
              <Th>Version</Th>
              <Th>Compared against</Th>
              <Th>Risk</Th>
              <Th>Decision</Th>
              <Th>npm</Th>
              <Th>Source</Th>
            </tr>
          </thead>
          <tbody>
            {releases.map((release) => (
              <ReleaseRow key={release.id} release={release} organizationId={organizationId} />
            ))}
          </tbody>
        </table>
      </Card>
    </section>
  );
}

function ReleaseRow({
  release,
  organizationId,
}: {
  release: PackageRelease;
  organizationId: string | null;
}) {
  const attention = releaseAttention(release);
  const rowClass = attention
    ? attention === "published_despite_block"
      ? "bg-danger-soft/60"
      : "bg-warn-soft/60"
    : "hover:bg-surface-2";
  const releaseRisk =
    release.status === "complete" ? (release.riskSummary?.releaseRisk ?? release.risk) : null;
  return (
    <tr class={`border-b border-border last:border-b-0 ${rowClass}`}>
      <Td class="whitespace-nowrap">
        <a href={scanDetailPath(release.id, organizationId)} class="font-mono text-[12px]">
          {release.stagedVersion || "—"}
        </a>
        <Caption>
          {formatDateTime(release.createdAt)}
          {release.registryStatusSupersededAt != null ? " · superseded" : ""}
        </Caption>
      </Td>
      <Td class="font-mono text-[12px] text-ink-muted whitespace-nowrap">
        {describeBaseline(release)}
      </Td>
      <Td>
        {releaseRisk ? (
          <Badge tone={severityTone(releaseRisk)}>{releaseRisk}</Badge>
        ) : release.status === "failed" ? (
          <Badge tone="critical">failed</Badge>
        ) : (
          <PlainState>{release.status}</PlainState>
        )}
      </Td>
      <Td>
        {release.decision ? (
          <>
            <DecisionState decision={release.decision} decidedAt={release.decidedAt} />
            {release.decidedByName ? <Caption>by {release.decidedByName}</Caption> : null}
          </>
        ) : (
          <PlainState>undecided</PlainState>
        )}
      </Td>
      <Td>
        <RegistryCell release={release} />
      </Td>
      <Td class="font-mono text-[12px] text-ink-muted whitespace-nowrap">
        {scanSourceLabel(release.source)}
      </Td>
    </tr>
  );
}

// npm's state for the row. A Badge only when it asks something of the reader
// (published with no decision here, over a block, blocked, or still holding an
// approved version); the expected endings read as plain text.
function RegistryCell({ release }: { release: PackageRelease }) {
  const registry = registryStatusBadge(release);
  if (!registry) return <PlainState>—</PlainState>;
  return (
    <div class="flex flex-col items-start gap-1">
      {registry.tone ? (
        <Badge tone={registry.tone}>{registry.label}</Badge>
      ) : (
        <PlainState>{registry.label}</PlainState>
      )}
      {release.registryVersionStatusAt ? (
        <Caption>seen {formatDateTime(release.registryVersionStatusAt)}</Caption>
      ) : null}
    </div>
  );
}

function PlainState({ children }: { children: ComponentChildren }) {
  return <span class="font-mono text-[12px] text-ink-muted whitespace-nowrap">{children}</span>;
}

function Caption({ children }: { children: ComponentChildren }) {
  return (
    <span class="block font-mono text-[11px] text-ink-subtle whitespace-nowrap">{children}</span>
  );
}

function Th({ children }: { children: ComponentChildren }) {
  return (
    <th class="text-left font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle px-4 py-2.5">
      {children}
    </th>
  );
}

function Td({ children, class: className }: { children: ComponentChildren; class?: string }) {
  // Baseline, not top: a link, a Badge, and plain mono text have different
  // line boxes, and top alignment left their first lines visibly staggered.
  return <td class={`px-4 py-2.5 align-baseline ${className || ""}`}>{children}</td>;
}

/**
 * An npm package's claim-aware sections around its release list. One claim
 * model serves the management choice and the badge, so a pending choice is
 * stated beside its control and only referred to elsewhere; a committed
 * choice remounts the sections whose authority it changed.
 */
function NpmPackageSections({
  packageName,
  personalWorkspace,
  onManagementChanged,
  children,
}: {
  packageName: string;
  personalWorkspace: ReadonlySignal<boolean>;
  onManagementChanged: () => void;
  children: ComponentChildren;
}) {
  const claim = useModel(() => new PackageClaimModel(packageName));
  const revision = useSignal(0);
  const claimPending = useComputed(() => {
    const loading = claim.loading.value;
    const management = claim.management.value;
    const pending = claim.pending.value;
    return loading || !management ? null : pending;
  });
  // The management choice sits under the release list, beside the monitor it
  // gates: it is housekeeping about the package, and the releases are what
  // the page is for.
  return (
    <>
      <RemountOn revision={revision}>
        <PublicBadgeSection
          packageName={packageName}
          ecosystem="npm"
          managementPending={claimPending}
        />
      </RemountOn>
      {children}
      <PackageManagement
        model={claim}
        packageName={packageName}
        onChanged={() => {
          revision.value++;
          onManagementChanged();
        }}
      />
      <RemountOn revision={revision}>
        <PackagePublicationSection
          packageName={packageName}
          personalWorkspace={personalWorkspace}
          onManagementRequired={() => void claim.load()}
        />
      </RemountOn>
    </>
  );
}

/**
 * Remounts its children when `revision` changes. Reading the revision here
 * keeps that subscription out of the page, which would otherwise re-render
 * every release row on each bump.
 */
function RemountOn({
  revision,
  children,
}: {
  revision: ReadonlySignal<string | number>;
  children: ComponentChildren;
}) {
  return <Fragment key={revision.value}>{children}</Fragment>;
}
