/**
 * One package's reviewed releases, grouped by channel (dist-tag), newest
 * first. Where the dashboard answers "what is waiting for me", this page
 * answers "what has shipped under this name, on which channel, and did npm's
 * outcome agree with ours" — the per-package, per-channel question npm's
 * multiple trusted-publishing configurations make maintainers ask.
 */
import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { useComputed, useModel, useSignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { useLocation, useRoute } from "preact-iso";
import { ecosystemLabel } from "../../../../server/lib/ecosystems/labels";
import { formatDateTime, pluralize } from "../../../lib/format";
import { rememberDashboardReturnUrl } from "../../../lib/query-state";
import { sessionModel } from "../../../models/auth";
import {
  PackageReleasesModel,
  type PackageRelease,
  type PackageReleasesResponse,
} from "../../../models/package-releases";
import { Alert } from "../../../components/Alert";
import { Badge, severityTone } from "../../../components/Badge";
import { Button, LinkButton } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { LoadingState } from "../../../components/Loading";
import { PageShell } from "../../../components/PageShell";
import { EmptyLine, MonoDetail, SectionLabel } from "../../../components/Typography";
import { UserMenu } from "../../../components/UserMenu";
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

export default function PackageReleasesPage() {
  const location = useLocation();
  const route = useRoute();
  const packageName = route.params.name ?? "";
  const ecosystem = location.query.ecosystem || "npm";
  // The model is built once per mount, so a navigation from one package page
  // straight to another must remount rather than reuse a model bound to the
  // previous name.
  return (
    <PackageReleasesView
      key={`${ecosystem}:${packageName}`}
      packageName={packageName}
      ecosystem={ecosystem}
    />
  );
}

function PackageReleasesView({
  packageName,
  ecosystem,
}: {
  packageName: string;
  ecosystem: string;
}) {
  const location = useLocation();
  const model = useModel(() => new PackageReleasesModel(packageName, ecosystem));
  const sessionChecked = useSignal(false);

  useEffect(() => {
    rememberDashboardReturnUrl(location.url);
  }, [location.url]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const data = await sessionModel.load();
      if (cancelled) return;
      if (!data) {
        location.route(`/login?returnTo=${encodeURIComponent(location.url)}`, true);
        return;
      }
      sessionChecked.value = true;
      await model.load();
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const channels = useComputed(() => groupReleasesByChannel(model.releases.value));
  const ready = useComputed(() => sessionChecked.value && model.loaded.value);
  const hasReleases = useComputed(() => model.releases.value.length > 0);

  const onSignOut = async () => {
    await sessionModel.signOut();
    location.route("/", true);
  };
  const user = sessionModel.user.value;

  return (
    <PageShell
      headerActions={
        <>
          <LinkButton variant="ghost" size="sm" href="/dashboard/settings">
            Settings
          </LinkButton>
          <UserMenu email={user?.email} name={user?.name} onSignOut={onSignOut} />
        </>
      }
    >
      <header class="flex flex-col gap-2 min-w-0">
        <a href="/dashboard" class="text-[13px] text-ink-muted hover:text-ink no-underline">
          ← Reviews
        </a>
        <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0 break-words">{packageName}</h1>
        <PackageDetailLine model={model} ecosystem={ecosystem} />
      </header>

      <Show when={model.error}>{(message) => <Alert tone="critical">{message}</Alert>}</Show>

      <Show
        when={ready}
        fallback={
          <LoadingState title="Loading releases" detail="confirming session · reading reviews" />
        }
      >
        {() => (
          <>
            <Show when={model.summary}>{(summary) => <AttentionAlert summary={summary} />}</Show>
            <Show
              when={hasReleases}
              fallback={
                <Card>
                  <EmptyLine>
                    No {ecosystemLabel(ecosystem)} releases of {packageName} have been reviewed in
                    this organization yet. Reviews start from the dashboard once a staged publish or
                    a gated release reaches Drydock.
                  </EmptyLine>
                </Card>
              }
            >
              {() => (
                <div class="flex flex-col gap-6">
                  {channels.value.map((channel) => (
                    <ChannelSection
                      key={channel.tag ?? ""}
                      tag={channel.tag}
                      releases={channel.releases}
                    />
                  ))}
                  <Show when={model.nextCursor}>
                    {() => (
                      <div class="flex justify-center">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => void model.loadMore()}
                          disabled={model.loadingMore}
                        >
                          <Show when={model.loadingMore} fallback="Load older releases">
                            Loading…
                          </Show>
                        </Button>
                      </div>
                    )}
                  </Show>
                </div>
              )}
            </Show>
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
}: {
  model: InstanceType<typeof PackageReleasesModel>;
  ecosystem: string;
}) {
  const parts = useComputed(() => {
    const summary = model.summary.value;
    if (!summary) return [ecosystemLabel(ecosystem)];
    const { totalReviews, channels, lastRelease } = summary;
    return [
      ecosystemLabel(ecosystem),
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

function ChannelSection({ tag, releases }: { tag: string | null; releases: PackageRelease[] }) {
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
              <ReleaseRow key={release.id} release={release} />
            ))}
          </tbody>
        </table>
      </Card>
    </section>
  );
}

function ReleaseRow({ release }: { release: PackageRelease }) {
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
        <a href={`/dashboard/scans/${encodeURIComponent(release.id)}`} class="font-mono text-xs">
          {release.stagedVersion || "—"}
        </a>
        <Caption>
          {formatDateTime(release.createdAt)}
          {release.registryStatusSupersededAt != null ? " · superseded" : ""}
        </Caption>
      </Td>
      <Td class="font-mono text-xs text-ink-muted whitespace-nowrap">
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
      <Td class="font-mono text-xs text-ink-muted whitespace-nowrap">
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
  return <span class="font-mono text-xs text-ink-muted whitespace-nowrap">{children}</span>;
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
