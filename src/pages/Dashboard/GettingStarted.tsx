import { Card } from "../../components/Card";
import { LinkButton } from "../../components/Button";
import { Badge } from "../../components/Badge";
import { Muted, SectionLabel } from "../../components/Typography";

// Shown only to an organization that has never had a scan.
//
// Getting to first value needs an external event — a staged publish, or a gated
// CI run — so the gap between "npm connected" and "first review" used to be
// unguided: the dashboard offered a disabled "Check npm" button, never linked to
// the docs, and the `npm stage publish` instruction lived only on /docs. This
// panel closes that gap and, for the wait in between, points at /diff, which
// runs the same deterministic rules over any published package with no setup at
// all — the fastest honest way to see what a review looks like on your own code.
export function GettingStarted({ npmConnected }: { npmConnected: boolean }) {
  return (
    <Card as="section" class="p-5 flex flex-col gap-4">
      <div class="flex flex-col gap-1.5">
        <SectionLabel as="h2">Get your first review</SectionLabel>
        <Muted class="text-[13px] m-0">
          Drydock reviews a release while it is still private, so the first review starts when you
          stage one.
        </Muted>
      </div>

      <ol class="list-none p-0 m-0 flex flex-col gap-3">
        <Step index={1} title="Connect npm" done={npmConnected}>
          {npmConnected ? (
            <>A read-only token is stored for this organization.</>
          ) : (
            <>
              Store a read-only npm token so Drydock can fetch staged tarballs.{" "}
              <a href="/dashboard/settings?tab=integrations" class="underline">
                Open settings
              </a>
              .
            </>
          )}
        </Step>
        <Step index={2} title="Stage a release">
          Run <Code>npm stage publish</Code> from your package directory. npm holds the candidate
          privately until you approve it. Drydock finds it automatically, or use{" "}
          <strong class="font-medium text-ink">Check npm</strong> below.
        </Step>
        <Step index={3} title="Review and decide">
          Read the diff, then approve the publish in npm with your own 2FA. Drydock never publishes.
        </Step>
      </ol>

      <div class="flex flex-col gap-2 border-t border-border pt-4">
        <Muted class="text-[13px] m-0">
          Not ready to stage one? Run the same deterministic rules over any published version pair —
          no token, no setup.
        </Muted>
        <div class="flex flex-wrap gap-2">
          <LinkButton variant="primary" size="sm" href="/diff">
            Diff a published package
          </LinkButton>
          <LinkButton variant="secondary" size="sm" href="/docs">
            Read the docs
          </LinkButton>
          <LinkButton variant="ghost" size="sm" href="/docs#gate-setup">
            Set up a CI workflow gate
          </LinkButton>
        </div>
      </div>
    </Card>
  );
}

function Step({
  index,
  title,
  done,
  children,
}: {
  index: number;
  title: string;
  done?: boolean;
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
      </div>
    </li>
  );
}

function Code({ children }: { children: preact.ComponentChildren }) {
  return <code class="font-mono text-[12px] text-ink">{children}</code>;
}
