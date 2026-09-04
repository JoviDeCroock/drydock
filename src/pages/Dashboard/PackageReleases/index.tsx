/**
 * One package's reviewed releases, grouped by channel (dist-tag), newest
 * first. Where the dashboard answers "what is waiting for me", this page
 * answers "what has shipped under this name, on which channel, and did npm's
 * outcome agree with ours" — the per-package, per-channel question npm's
 * multiple trusted-publishing configurations make maintainers ask.
 */
import { useEffect } from "preact/hooks";
import { useComputed, useModel, useSignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { useLocation, useRoute } from "preact-iso";
import { ecosystemLabel } from "../../../../server/lib/ecosystems/labels";
import { formatDateTime, pluralize } from "../../../lib/format";
import { rememberDashboardReturnUrl } from "../../../lib/query-state";
import { sessionModel } from "../../../models/auth";
import { PackageReleasesModel, type PackageRelease } from "../../../models/package-releases";
import { Alert } from "../../../components/Alert";
import { Badge, severityTone } from "../../../components/Badge";
import { Button, LinkButton } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { LoadingState } from "../../../components/Loading";
import { PageShell } from "../../../components/PageShell";
import { EmptyLine, MonoDetail, MonoLabel, SectionLabel } from "../../../components/Typography";
import { UserMenu } from "../../../components/UserMenu";
import {
  channelLabel,
  describeBaseline,
  groupReleasesByChannel,
  releaseAttention,
  type ReleaseAttention,
} from "../../../features/package-releases";
import { registryStatusBadge } from "../../../features/registry-status";

export default function PackageReleasesPage() {
  const location = useLocation();
  const route = useRoute();
  const packageName = route.params.name ?? "";
  const ecosystem = location.query.ecosystem || "npm";
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
  }, [packageName, ecosystem]);

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
        <MonoDetail
          parts={[ecosystemLabel(ecosystem), <SummaryLine key="summary" model={model} />]}
        />
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
            <Show when={model.summary}>{(summary) => <SummaryStrip summary={summary} />}</Show>
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

function SummaryLine({ model }: { model: InstanceType<typeof PackageReleasesModel> }) {
  const text = useComputed(() => {
    const summary = model.summary.value;
    if (!summary) return "reviews";
    return `${summary.totalReviews} ${pluralize("review", summary.totalReviews)}`;
  });
  return <span>{text}</span>;
}

// Four facts, one Card each, in the status-strip shape the dashboard already
// uses. The last two are the counts that matter per package: releases npm
// shipped that nobody here reviewed, and releases npm shipped over a block.
function SummaryStrip({
  summary,
}: {
  summary: NonNullable<InstanceType<typeof PackageReleasesModel>["summary"]["value"]>;
}) {
  const channelNames = summary.channels.map((channel) => channelLabel(channel.tag));
  const unreviewedTone = summary.publishedWithoutDecision > 0 ? "medium" : "ok";
  const overriddenTone = summary.publishedDespiteBlock > 0 ? "critical" : "ok";
  return (
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <SummaryCard label="reviews">
        <span class="text-[18px] font-medium tracking-[-0.01em]">{summary.totalReviews}</span>
        <span class="text-[13px] text-ink-muted">
          {summary.channels.length} {pluralize("channel", summary.channels.length)}
        </span>
      </SummaryCard>
      <SummaryCard label="channels">
        <span class="font-mono text-[13px] break-words">{channelNames.join(" · ") || "—"}</span>
      </SummaryCard>
      <SummaryCard label="last release">
        {summary.lastRelease ? (
          <>
            <a
              href={`/dashboard/scans/${encodeURIComponent(summary.lastRelease.id)}`}
              class="font-mono text-[13px]"
            >
              {summary.lastRelease.version ?? "—"}
              {summary.lastRelease.tag ? ` (${summary.lastRelease.tag})` : ""}
            </a>
            <span class="font-mono text-[11px] text-ink-subtle">
              {formatDateTime(summary.lastRelease.createdAt)}
            </span>
          </>
        ) : (
          <span class="text-[13px] text-ink-muted">—</span>
        )}
      </SummaryCard>
      <SummaryCard label="npm-published, unreviewed">
        <span class="flex flex-wrap items-center gap-2">
          <Badge tone={unreviewedTone}>{summary.publishedWithoutDecision}</Badge>
          {summary.publishedDespiteBlock > 0 ? (
            <Badge tone={overriddenTone}>{summary.publishedDespiteBlock} over a block</Badge>
          ) : null}
        </span>
        <span class="text-[13px] text-ink-muted">published by npm with no Drydock decision</span>
      </SummaryCard>
    </div>
  );
}

function SummaryCard({ label, children }: { label: string; children: preact.ComponentChildren }) {
  return (
    <Card padding="compact" class="flex flex-col gap-1.5 min-h-[96px]">
      <MonoLabel>{label}</MonoLabel>
      {children}
    </Card>
  );
}

function ChannelSection({ tag, releases }: { tag: string | null; releases: PackageRelease[] }) {
  return (
    <section class="flex flex-col gap-3">
      <SectionLabel as="h2" aside={`${releases.length} ${pluralize("release", releases.length)}`}>
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
              <Th>Review</Th>
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

const ATTENTION_COPY: Record<ReleaseAttention, { label: string; tone: "medium" | "critical" }> = {
  published_without_review: { label: "approved in npm without a Drydock review", tone: "medium" },
  published_despite_block: { label: "blocked here, published by npm", tone: "critical" },
};

const SOURCE_LABELS: Record<string, string> = {
  manual: "manual",
  auto_discovery: "discovered",
  workflow_gate: "workflow gate",
  published: "published pair",
};

function ReleaseRow({ release }: { release: PackageRelease }) {
  const attention = releaseAttention(release);
  const rowClass = attention
    ? attention === "published_despite_block"
      ? "bg-danger-soft/60"
      : "bg-warn-soft/60"
    : "hover:bg-surface-2";
  const releaseRisk =
    release.status === "complete" ? (release.riskSummary?.releaseRisk ?? release.risk) : null;
  const registry = registryStatusBadge(release);
  const scanHref = `/dashboard/scans/${encodeURIComponent(release.id)}`;
  return (
    <tr class={`border-b border-border last:border-b-0 ${rowClass}`}>
      <Td class="font-mono text-xs whitespace-nowrap">
        <div class="flex flex-col gap-1">
          <a href={scanHref} class="text-ink">
            {release.stagedVersion || "—"}
          </a>
          {attention ? (
            <Badge tone={ATTENTION_COPY[attention].tone}>{ATTENTION_COPY[attention].label}</Badge>
          ) : null}
          {release.registryStatusSupersededAt != null ? (
            <Badge tone="unchanged">superseded</Badge>
          ) : null}
        </div>
      </Td>
      <Td class="font-mono text-xs text-ink-muted whitespace-nowrap">
        {describeBaseline(release)}
      </Td>
      <Td>
        {releaseRisk ? (
          <Badge tone={severityTone(releaseRisk)}>{releaseRisk}</Badge>
        ) : (
          <Badge tone={release.status === "failed" ? "critical" : "neutral"}>
            {release.status}
          </Badge>
        )}
      </Td>
      <Td>
        <DecisionCell release={release} />
      </Td>
      <Td>
        {registry ? (
          <div class="flex flex-col gap-1">
            <Badge tone={registry.tone}>{registry.label}</Badge>
            {release.registryVersionStatusAt ? (
              <span class="font-mono text-[11px] text-ink-subtle whitespace-nowrap">
                seen {formatDateTime(release.registryVersionStatusAt)}
              </span>
            ) : null}
          </div>
        ) : release.registryReleaseOutcome ? (
          <Badge tone="unchanged">npm {release.registryReleaseOutcome}</Badge>
        ) : (
          <span class="font-mono text-xs text-ink-subtle">—</span>
        )}
      </Td>
      <Td class="font-mono text-xs text-ink-muted whitespace-nowrap">
        {SOURCE_LABELS[release.source] ?? release.source}
      </Td>
      <Td class="whitespace-nowrap">
        <a href={scanHref} class="text-[13px]">
          open →
        </a>
        <span class="block font-mono text-[11px] text-ink-subtle">
          {formatDateTime(release.createdAt)}
        </span>
      </Td>
    </tr>
  );
}

function DecisionCell({ release }: { release: PackageRelease }) {
  if (!release.decision) {
    return <Badge tone="neutral">undecided</Badge>;
  }
  const approved = release.decision === "publish";
  return (
    <div class="flex flex-col gap-1">
      <Badge tone={approved ? "ok" : "critical"}>{approved ? "approved" : "blocked"}</Badge>
      <span class="font-mono text-[11px] text-ink-subtle whitespace-nowrap">
        {release.decidedByName ?? "unknown reviewer"}
        {release.decidedAt ? ` · ${formatDateTime(release.decidedAt)}` : ""}
      </span>
    </div>
  );
}

function Th({ children }: { children: preact.ComponentChildren }) {
  return (
    <th class="text-left font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle px-4 py-2.5">
      {children}
    </th>
  );
}

function Td({
  children,
  class: className,
}: {
  children: preact.ComponentChildren;
  class?: string;
}) {
  return <td class={`px-4 py-2.5 align-top ${className || ""}`}>{children}</td>;
}
