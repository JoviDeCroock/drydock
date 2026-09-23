/**
 * The package's public README badge as this organization controls it: whether
 * its reviews answer the badge at all, and — for owners and admins — the
 * switch that turns that off. The page's one place to withdraw a public claim
 * that no single share or listing can: a default-on badge never depended on
 * either.
 */
import { useEffect } from "preact/hooks";
import { useComputed, useModel } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { formatDateTime } from "../../../lib/format";
import { PackageBadgeModel, type PackageBadgeState } from "../../../models/package-badge";
import { Alert } from "../../../components/Alert";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { EmptyLine, SectionLabel } from "../../../components/Typography";

function describeBadge(state: PackageBadgeState): string {
  if (!state.enabled) {
    const since = state.disabledAt ? ` since ${formatDateTime(state.disabledAt)}` : "";
    return `Off${since}. None of this organization's reviews answer the badge, listed ones included; threat-feed entries are unaffected.`;
  }
  if (state.answersByDefault) {
    return "Your approved releases answer the badge once npm publishes them, with nothing to share or list.";
  }
  if (state.listed) {
    return "Reviews you list in the threat feed answer the badge.";
  }
  return "No review of yours answers the badge yet.";
}

export function PublicBadgeSection({
  packageName,
  ecosystem,
}: {
  packageName: string;
  ecosystem: string;
}) {
  const model = useModel(() => new PackageBadgeModel(packageName, ecosystem));

  useEffect(() => {
    void model.load();
  }, []);

  const aside = useComputed(() => {
    const state = model.state.value;
    return state ? (state.enabled ? "on" : "off") : null;
  });

  return (
    <section class="flex flex-col gap-3">
      <SectionLabel as="h2" aside={aside}>
        public badge
      </SectionLabel>
      <Show when={model.error}>{(message) => <Alert tone="warn">{message}</Alert>}</Show>
      <Show
        when={model.state}
        fallback={
          <Show when={model.busy}>
            <p class="font-mono text-[12px] text-ink-muted m-0">Reading badge state…</p>
          </Show>
        }
      >
        {(state) => (
          <Card
            padding="compact"
            class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div class="flex flex-col gap-1.5 min-w-0">
              <span class="flex flex-wrap items-center gap-2">
                <Badge tone={state.enabled ? "ok" : "neutral"}>
                  {state.enabled ? "on" : "off"}
                </Badge>
                <span class="font-mono text-[11px] text-ink-subtle break-all">
                  /public/badge/{ecosystem}/{packageName}
                </span>
              </span>
              <EmptyLine>{describeBadge(state)}</EmptyLine>
            </div>
            {state.canManage ? (
              <Button
                variant="secondary"
                size="sm"
                class="shrink-0"
                disabled={model.busy}
                onClick={() => void model.setEnabled(!state.enabled)}
              >
                {state.enabled ? "Turn badge off" : "Turn badge on"}
              </Button>
            ) : (
              <EmptyLine class="shrink-0">Owners and admins can change this.</EmptyLine>
            )}
          </Card>
        )}
      </Show>
    </section>
  );
}
