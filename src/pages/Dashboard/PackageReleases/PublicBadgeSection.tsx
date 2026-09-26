/**
 * The package's public README badge as this organization sees it: what the
 * public endpoint answers right now, the README snippet, and — for a
 * registry-verified publisher's owners and admins — the "public badge: off"
 * switch, which silences the badge for every organization's reviews.
 */
import { useComputed, useModel, useSignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { badgeMarkdown } from "../../../lib/badge-markdown";
import { formatDateTime } from "../../../lib/format";
import {
  PackageBadgeModel,
  type BadgePreview,
  type PackageBadgeState,
} from "../../../models/package-badge";
import type { PublicEcosystem } from "../../../../server/lib/public-feed";
import { Alert } from "../../../components/Alert";
import { Badge, type BadgeTone } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { Input } from "../../../components/Input";
import { EmptyLine, MonoLabel, SectionLabel } from "../../../components/Typography";

function switchedOff(state: PackageBadgeState): boolean {
  return state.switchedOffByYou || state.switchedOffElsewhere;
}

function describeBadge(state: PackageBadgeState, ecosystem: PublicEcosystem): string {
  if (!state.eligible && ecosystem !== "npm") {
    return "This badge has no off switch: only npm has registry-verified reviews. To withdraw one of your own reviews from it, unlist the review.";
  }
  if (!state.eligible) {
    return "Only an organization with a registry-verified review of this package — a staged release on public npm whose manifest matches npm's name — can switch its badge off. To withdraw one of your own reviews from it, unlist the review.";
  }
  const since = state.switchedOffAt ? ` since ${formatDateTime(state.switchedOffAt)}` : "";
  if (state.switchedOffByYou && state.switchedOffElsewhere) {
    return `Switched off${since} for every organization's reviews. Another publisher of this package has switched it off too, so turning yours back on leaves it off.`;
  }
  if (state.switchedOffByYou) {
    return `Switched off${since}: no organization's review answers the badge, listed ones included. Threat-feed entries are unaffected.`;
  }
  if (state.switchedOffElsewhere) {
    return "Switched off by another publisher of this package: no organization's review answers the badge, yours included, until they turn it back on.";
  }
  if (state.answersByDefault) {
    return "Allowed. Your approved releases answer the badge once npm publishes them, with nothing to share or list.";
  }
  if (state.listed) return "Allowed. Reviews you list in the threat feed answer the badge.";
  return "Allowed, but nothing of yours answers it yet: approve a release npm publishes, or list a review.";
}

// shields.io colour names, onto the system's severity tones.
const PREVIEW_TONES: Record<string, BadgeTone> = {
  brightgreen: "ok",
  green: "ok",
  yellow: "medium",
  orange: "high",
  red: "critical",
};

function EndpointPreview({ preview }: { preview: BadgePreview }) {
  return (
    <span class="flex flex-wrap items-center gap-2">
      <MonoLabel>public endpoint says</MonoLabel>
      <span class="font-mono text-[12px] text-ink-muted">{preview.label}</span>
      <Badge tone={PREVIEW_TONES[preview.color] ?? "neutral"}>{preview.message}</Badge>
    </span>
  );
}

function ReadmeSnippet({ markdown }: { markdown: string }) {
  const copied = useSignal(false);
  // Rendered as a signal child so the feedback re-renders only the text node.
  const copyLabel = useComputed(() => (copied.value ? "Copied ✓" : "Copy"));
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      copied.value = true;
      setTimeout(() => (copied.value = false), 2000);
    } catch {
      // Clipboard access denied — the text stays selectable in the input.
    }
  };
  return (
    <div class="flex flex-col gap-1.5">
      <MonoLabel as="span">README badge</MonoLabel>
      <div class="flex items-center gap-2">
        <Input value={markdown} readOnly mono class="flex-1 min-w-0" />
        <Button variant="secondary" size="sm" onClick={() => void copy()}>
          {copyLabel}
        </Button>
      </div>
    </div>
  );
}

export function PublicBadgeSection({
  packageName,
  ecosystem,
}: {
  packageName: string;
  ecosystem: PublicEcosystem;
}) {
  const model = useModel(() => new PackageBadgeModel(packageName, ecosystem));

  // npm links its evergreen package diff; the other ecosystems link a share
  // URL, which only a scan's share dialog has.
  const markdown =
    ecosystem === "npm"
      ? badgeMarkdown({ origin: location.origin, ecosystem, packageName, reportUrl: "" })
      : null;

  return (
    <section class="flex flex-col gap-3">
      <SectionLabel as="h2">public badge</SectionLabel>
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
          <Card padding="compact" class="flex flex-col gap-3">
            <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div class="flex flex-col gap-1.5 min-w-0">
                <span class="flex flex-wrap items-center gap-2">
                  {/* Only a publisher is told the switch state; to anyone else it
                      would disclose another organization's choice. */}
                  {state.eligible ? (
                    <Badge tone="neutral">{switchedOff(state) ? "switched off" : "allowed"}</Badge>
                  ) : null}
                  <Show when={model.preview}>
                    {(preview) => <EndpointPreview preview={preview} />}
                  </Show>
                </span>
                <EmptyLine>{describeBadge(state, ecosystem)}</EmptyLine>
              </div>
              {state.eligible ? (
                state.canManage ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    class="shrink-0"
                    disabled={model.busy}
                    onClick={() => void model.setEnabled(state.switchedOffByYou)}
                  >
                    {state.switchedOffByYou ? "Turn badge on" : "Turn badge off"}
                  </Button>
                ) : (
                  <EmptyLine class="shrink-0">Owners and admins can change this.</EmptyLine>
                )
              ) : null}
            </div>
            {markdown ? <ReadmeSnippet markdown={markdown} /> : null}
          </Card>
        )}
      </Show>
    </section>
  );
}
