import { useModel, useSignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { useLocation } from "preact-iso";
import { parsePackageSpec, PublishedReviewModel } from "../../models/published-review";
import { Alert } from "../../components/Alert";
import { Badge } from "../../components/Badge";
import { Button, LinkButton } from "../../components/Button";
import { Card } from "../../components/Card";
import { CopyButton } from "../../components/CopyButton";
import { Input } from "../../components/Input";
import { InlineCode, Muted, SectionLabel } from "../../components/Typography";

// The one command that starts a staged publish. It takes no package argument —
// npm reads the package from the directory it runs in — so the package name
// belongs in the sentence next to it, never inside the copied text.
const STAGE_COMMAND = "npm stage publish";

/**
 * The onboarding funnel for an organization working towards a first review.
 *
 * Getting to first value needs an external event — a staged publish, or a gated
 * CI run — so the gap between "npm connected" and "first review" was unguided:
 * the dashboard offered a disabled "Check npm" button, never linked to the docs,
 * and the `npm stage publish` instruction lived only on /docs.
 *
 * The panel is shown only while the organization has no review at all, so the
 * first step is always still open here. `DashboardOnboarding` closes it the
 * moment a first review exists: the report is the thing to look at then, and
 * the later steps are optional and explained where they happen. The npm step
 * can already be ticked (a token connected before any review), which is why it
 * still carries a done state.
 *
 * The first step is the one thing that needs no token and nothing to wait for:
 * a persisted review of a package that is already public.
 */
export function GettingStarted({
  npmConnected,
  npmScope,
  onDismiss,
}: {
  npmConnected: boolean;
  /** The connection's own npm scope, when there is one, to prefill step 1. */
  npmScope: string | null;
  onDismiss: () => void;
}) {
  return (
    <Card as="section" padding="compact" class="flex flex-col gap-4">
      <div class="flex flex-col gap-1.5">
        <SectionLabel
          as="h2"
          aside={
            <Button variant="ghost" size="sm" onClick={onDismiss} title="Hide this panel">
              Dismiss
            </Button>
          }
        >
          Get your first review
        </SectionLabel>
        <Muted class="text-[13px] m-0">
          Start with a package you already publish: the first review needs no token and nothing to
          wait for. Staged and gated releases land here the same way afterwards.
        </Muted>
      </div>

      <ol class="list-none p-0 m-0 flex flex-col gap-3">
        <Step
          index={1}
          title="Review one of your published packages"
          action={<PublishedReviewForm npmScope={npmScope} />}
        >
          Name a package you publish. Drydock reviews its latest release against the one before it —
          the full report, kept in this organization, with nothing to install and no token to
          create.
        </Step>
        <Step
          index={2}
          title="Connect npm to watch staged releases"
          done={npmConnected}
          action={
            npmConnected ? null : (
              <div class="flex flex-wrap items-center gap-2">
                {/* Selectable next to the copy control: clipboard access is
                    denied outside secure contexts, and the fallback is to
                    select the command by hand. */}
                <code class="font-mono text-[12px] leading-[1.6] text-ink bg-surface-2 border border-border rounded px-2.5 py-1.5 whitespace-pre-wrap break-words">
                  {STAGE_COMMAND}
                </code>
                <CopyButton text={STAGE_COMMAND} label="Copy command" />
              </div>
            )
          }
        >
          {npmConnected ? (
            <>
              A read-only token is stored for this organization. Run{" "}
              <InlineCode>{STAGE_COMMAND}</InlineCode> from your package directory and Drydock finds
              the candidate, or use <strong class="font-medium text-ink">Check npm</strong> below.
            </>
          ) : (
            <>
              Optional, and only for reviewing a release <em>before</em> it is public. Store an npm
              token — a granular one with{" "}
              <strong class="font-medium text-ink">Packages and scopes: Read-only</strong> and{" "}
              <strong class="font-medium text-ink">Organizations: No access</strong> — then run{" "}
              <InlineCode>{STAGE_COMMAND}</InlineCode> from your package directory.{" "}
              <a href="/dashboard/settings?tab=integrations" class="underline">
                Open settings
              </a>
              .
            </>
          )}
        </Step>
        <Step index={3} title="Review and decide">
          Read the diff, then approve the publish in npm with your own 2FA. Drydock never publishes.
        </Step>
      </ol>

      <CiPublisherTrack />
    </Card>
  );
}

// The parallel track. A release built and published by a workflow never runs
// `npm stage publish`, so for those maintainers the three steps above describe
// someone else's job; the gate pauses the workflow run instead and asks for the
// same review.
function CiPublisherTrack() {
  return (
    <div class="rounded-md border border-border bg-surface-2 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
      <div class="flex flex-col gap-1 min-w-0">
        <h3 class="text-[14px] font-medium tracking-[-0.005em] m-0">Publishing from CI?</h3>
        <Muted class="text-[13px] m-0 leading-[1.6]">
          A workflow gate holds the release in the workflow run instead, with the same review and
          the same decision.
        </Muted>
      </div>
      <LinkButton variant="secondary" size="sm" href="/dashboard/settings?tab=integrations">
        Set up a workflow gate
      </LinkButton>
    </div>
  );
}

// First value before any credential: the full authenticated review — the same
// rules, AI review, report, and decision — over a release that is already
// public. Nothing here needs an npm connection or a staged candidate, which is
// the whole point of putting it first.
function PublishedReviewForm({ npmScope }: { npmScope: string | null }) {
  const location = useLocation();
  // A connected organization's own npm scope is the likeliest prefix of the
  // package it wants to review; without one the placeholder does the teaching.
  const spec = useSignal(npmScope ? `${npmScope}/` : "");
  const review = useModel(PublishedReviewModel);

  const start = async () => {
    const parsed = parsePackageSpec(spec.peek());
    if (!parsed) return;
    const scanId = await review.start("npm", parsed);
    if (scanId) location.route(`/dashboard/scans/${encodeURIComponent(scanId)}`);
  };

  return (
    <div class="flex flex-col gap-2">
      <form
        class="flex flex-wrap gap-2 items-center"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <Input
          type="text"
          value={spec}
          placeholder="package, e.g. react — or react@19.0.0"
          aria-label="npm package name, optionally with a version"
          autoComplete="off"
          spellcheck={false}
          class="flex-1 min-w-[200px] max-w-[380px]"
          onInput={(event) => (spec.value = (event.target as HTMLInputElement).value)}
        />
        <Button type="submit" size="sm" disabled={review.busy}>
          <Show when={review.busy} fallback="Review it">
            Starting…
          </Show>
        </Button>
        <LinkButton variant="ghost" size="sm" href="/docs">
          Read the docs
        </LinkButton>
      </form>
      <Show when={review.error}>{(message) => <Alert tone="critical">{message}</Alert>}</Show>
    </div>
  );
}

function Step({
  index,
  title,
  done,
  action,
  children,
}: {
  index: number;
  title: string;
  done?: boolean;
  action?: preact.ComponentChildren;
  children: preact.ComponentChildren;
}) {
  return (
    <li class="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3">
      <span
        aria-hidden
        class={`font-mono text-[11px] font-medium tabular-nums leading-none pt-[3px] ${
          done ? "text-ok-text" : "text-ink-subtle"
        }`}
      >
        {done ? "✓" : String(index).padStart(2, "0")}
      </span>
      <div class="flex flex-col gap-1 min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="text-[14px] font-medium tracking-[-0.005em] m-0">{title}</h3>
          {done ? <Badge tone="ok">done</Badge> : null}
        </div>
        <p class="m-0 text-[13px] text-ink-muted leading-[1.6]">{children}</p>
        {action ? <div class="mt-1">{action}</div> : null}
      </div>
    </li>
  );
}
