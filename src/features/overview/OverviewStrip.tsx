/**
 * The dashboard overview strip: four call-to-action tiles above Recent reviews.
 *
 * Every npm-status figure comes from the persisted registry status, and an
 * unknown status is counted only as "not settled" — it is never shown as a
 * verdict. The strip is absent for an organization with no scans, and a
 * refresh keeps the previous figures on screen so the layout never jumps.
 *
 * Each tile is a plain link to the dashboard with the matching `?filter=`;
 * the list's filter is two-way bound to that query parameter, so following
 * the link applies the filter without a second code path.
 */
import { useComputed, useSignal, type ReadonlySignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { useEffect } from "preact/hooks";
import { LoadingLine, MonoLabel, Muted } from "../../components/Typography";
import type { ScanOverview } from "../../models/scan-overview";
import { overviewTileHref, overviewTiles, type OverviewTile } from "./tiles";

export function OverviewStrip({
  overview,
  loaded,
  error,
}: {
  overview: ReadonlySignal<ScanOverview | null>;
  loaded: ReadonlySignal<boolean>;
  error: ReadonlySignal<string | null>;
}) {
  const now = useSignal(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => {
      now.value = Date.now();
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);

  const tiles = useComputed<OverviewTile[] | null>(() => {
    const data = overview.value;
    const at = now.value;
    if (!data || data.totalScans === 0) return null;
    return overviewTiles(data, at);
  });
  const pending = useComputed(() => !loaded.value && overview.value === null);
  const failed = useComputed(() => (overview.value === null ? error.value : null));

  return (
    <>
      <Show when={pending}>{() => <LoadingLine size="inline">Loading overview</LoadingLine>}</Show>
      <Show when={failed}>
        {(message) => (
          <Muted class="text-[12px] font-mono m-0">Overview could not load. {message}</Muted>
        )}
      </Show>
      <Show when={tiles}>
        {(items) => (
          <section aria-labelledby="dashboard-overview-heading">
            <h2 id="dashboard-overview-heading" class="sr-only">
              Overview
            </h2>
            <ul class="grid grid-cols-2 lg:grid-cols-4 gap-3 list-none m-0 p-0">
              {items.map((tile) => (
                <li key={tile.id} class="min-w-0">
                  <OverviewTileLink tile={tile} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </Show>
    </>
  );
}

function OverviewTileLink({ tile }: { tile: OverviewTile }) {
  return (
    <a
      href={overviewTileHref(tile.filter)}
      data-overview-tile={tile.id}
      class="flex flex-col gap-1.5 h-full bg-surface border border-border rounded-lg p-4 no-underline text-ink hover:border-accent focus-visible:border-accent transition-colors duration-150"
    >
      <MonoLabel>{tile.label}</MonoLabel>
      <span class="font-mono text-[18px] font-medium leading-none tracking-[-0.01em] tabular-nums">
        {tile.value}
      </span>
      <span class="font-mono text-[11px] leading-[1.4] text-ink-muted">{tile.detail}</span>
    </a>
  );
}
