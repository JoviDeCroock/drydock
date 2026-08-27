import { useSignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { useLocation } from "preact-iso";
import { resolveSuggestedDiffPath } from "../../models/package-diff";
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
 * Each step ticks on its own, including the last one: the panel is opened by
 * `DashboardOnboarding` and closed only by the reader, so recording a first
 * decision ticks step 3 in place instead of taking the whole panel away at the
 * moment it completes. The earlier version disappeared at the first scan, which
 * meant steps 2 and 3 could never be seen ticking at all — it claimed to track
 * a funnel it structurally could not follow.
 *
 * While the wait for a staged release lasts, the panel offers the one thing
 * that needs no token: a public npm package diff.
 */
export function GettingStarted({
  npmConnected,
  hasAnyScan,
  hasAnyDecision,
  onDismiss,
}: {
  npmConnected: boolean;
  hasAnyScan: boolean;
  hasAnyDecision: boolean;
  onDismiss: () => void;
}) {
  // The funnel's own endpoint: a release was reviewed and decided. Step 1 can
  // still be open at this point — a workflow gate reaches a first decision
  // without an npm token — so the step list stays honest either way.
  const complete = hasAnyScan && hasAnyDecision;

  return (
    <Card as="section" class="p-5 flex flex-col gap-4">
      <div class="flex flex-col gap-1.5">
        <SectionLabel
          as="h2"
          aside={
            <Button variant="ghost" size="sm" onClick={onDismiss} title="Hide this panel">
              {complete ? "Done" : "Dismiss"}
            </Button>
          }
        >
          {complete ? "That is the whole loop" : "Get your first review"}
        </SectionLabel>
        <Muted class="text-[13px] m-0">
          {complete ? (
            <>
              Reviewed before it shipped, with the decision still in your hands. Every staged
              release and gated run lands here from now on — close this when you are ready.
            </>
          ) : (
            <>
              Drydock reviews a release while it is still private, so the first review starts when
              you stage one.
            </>
          )}
        </Muted>
      </div>

      <ol class="list-none p-0 m-0 flex flex-col gap-3">
        <Step index={1} title="Connect npm" done={npmConnected}>
          {npmConnected ? (
            <>A read-only token is stored for this organization.</>
          ) : (
            <>
              Store an npm token so Drydock can fetch staged tarballs — a granular token with{" "}
              <strong class="font-medium text-ink">Packages and scopes: Read-only</strong> and{" "}
              <strong class="font-medium text-ink">Organizations: No access</strong>.{" "}
              <a href="/dashboard/settings?tab=integrations" class="underline">
                Open settings
              </a>
              .
            </>
          )}
        </Step>
        <Step
          index={2}
          title="Stage a release"
          done={hasAnyScan}
          action={
            hasAnyScan ? null : (
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
          {hasAnyScan ? (
            <>A staged release has been reviewed for this organization.</>
          ) : (
            <>
              Run <InlineCode>{STAGE_COMMAND}</InlineCode> from your package directory. npm holds
              the candidate privately until you approve it. Drydock finds it automatically, or use{" "}
              <strong class="font-medium text-ink">Check npm</strong> below.
            </>
          )}
        </Step>
        <Step index={3} title="Review and decide" done={hasAnyDecision}>
          {hasAnyDecision ? (
            <>
              A decision is recorded for this organization. An npm approval still needs your own 2FA
              — Drydock never publishes.
            </>
          ) : (
            <>
              Read the diff, then approve the publish in npm with your own 2FA. Drydock never
              publishes.
            </>
          )}
        </Step>
      </ol>

      {hasAnyScan ? null : <FirstDiff />}

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

// First value before any token: the same deterministic rules, run over a
// package that is already published. Nothing here is organization state, so it
// needs no npm connection and no staged release to wait for.
function FirstDiff() {
  const location = useLocation();
  const packageName = useSignal("");
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);

  const open = async () => {
    const input = packageName.peek().trim();
    if (!input || busy.peek()) return;
    busy.value = true;
    error.value = null;
    try {
      // The same resolution the /diff landing form uses, so both entry points
      // agree on which version pair "latest release" means and on the error
      // copy when a package has only ever published once.
      const resolved = await resolveSuggestedDiffPath("npm", input);
      if ("error" in resolved) error.value = resolved.error;
      else location.route(resolved.path);
    } finally {
      busy.value = false;
    }
  };

  return (
    <div class="flex flex-col gap-2">
      <h3 class="text-[14px] font-medium tracking-[-0.005em] m-0">
        See the public diff of your latest release
      </h3>
      <Muted class="text-[13px] m-0 leading-[1.6]">
        No token, no staged release, no wait — the same deterministic rules over the last two
        published versions of an npm package.
      </Muted>
      <form
        class="flex flex-wrap gap-2 items-center"
        onSubmit={(event) => {
          event.preventDefault();
          void open();
        }}
      >
        <Input
          type="text"
          value={packageName}
          placeholder="package name, e.g. react"
          aria-label="npm package name"
          autoComplete="off"
          spellcheck={false}
          class="flex-1 min-w-[200px] max-w-[380px]"
          onInput={(event) => (packageName.value = (event.target as HTMLInputElement).value)}
        />
        <Button type="submit" size="sm" disabled={busy}>
          <Show when={busy} fallback="See the diff">
            Loading versions…
          </Show>
        </Button>
        <LinkButton variant="ghost" size="sm" href="/docs">
          Read the docs
        </LinkButton>
      </form>
      <Show when={error}>{(message) => <Alert tone="critical">{message}</Alert>}</Show>
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
