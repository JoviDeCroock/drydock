import type { ComponentChildren } from "preact";
import { useEffect, useErrorBoundary, useMemo } from "preact/hooks";
import { useLocation } from "preact-iso";
import { Button, LinkButton } from "../../components/Button";
import { Card } from "../../components/Card";
import { CopyButton } from "../../components/CopyButton";
import { PageShell } from "../../components/PageShell";
import { MonoLabel, Muted } from "../../components/Typography";
import { CONTACT_EMAIL } from "../../lib/contact";
import { buildBugReport, bugReportMailto } from "./bug-report";

/**
 * Replaces a page that threw while rendering with a recovery card instead of a
 * blank screen. Render and lifecycle errors reach it, and so do failed route
 * chunk loads through `lazyRoute`. A route that is still loading suspends
 * through preact-iso before any error boundary sees the thrown promise, and
 * event-handler errors never unmount the tree.
 */
export function AppErrorBoundary({ children }: { children: ComponentChildren }) {
  const { url, path } = useLocation();
  const [error, resetError] = useErrorBoundary((caught) => console.error(caught));

  // Leaving the broken page is the way out, so any client-side navigation
  // (the header brand mark, a footer link) gives the next route a fresh render.
  // The closure's `error` is the one from the render that saw the new URL, so
  // an error the new page throws on its first render is not cleared here.
  useEffect(() => {
    if (error) resetError();
  }, [url]);

  if (!error) return <>{children}</>;
  return <ErrorFallback error={error} path={path} />;
}

function ErrorFallback({ error, path }: { error: unknown; path: string }) {
  const report = useMemo(
    () =>
      buildBugReport({
        error,
        pathname: path,
        userAgent: navigator.userAgent,
        occurredAt: new Date(),
      }),
    [error, path],
  );

  return (
    <PageShell width="narrow">
      <Card class="flex flex-col gap-3">
        <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">Something went wrong</h1>
        <Muted class="text-[13px] m-0">
          This page hit an error it couldn't recover from. Reloading usually fixes it. If it keeps
          happening, email the details below to {CONTACT_EMAIL}.
        </Muted>
        <div class="mt-2 flex flex-wrap gap-2">
          <Button onClick={() => location.reload()}>Reload page</Button>
          <LinkButton href={bugReportMailto(report)} variant="secondary">
            Email bug report
          </LinkButton>
        </div>
        <div class="mt-2 flex flex-col gap-2">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <MonoLabel as="p">Error details</MonoLabel>
            <CopyButton text={report} label="Copy details" variant="ghost" />
          </div>
          <pre class="m-0 max-h-56 overflow-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-[12px] leading-[1.55] text-ink-muted whitespace-pre-wrap break-words">
            {report}
          </pre>
          <Muted class="text-[12px] m-0">
            Nothing is sent automatically. Review the details before you share them.
          </Muted>
        </div>
      </Card>
    </PageShell>
  );
}
