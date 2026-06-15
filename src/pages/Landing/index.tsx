import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { useSignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { homePageSeo, PageSeo } from "../../lib/seo";
import { sessionModel } from "../../models/auth";
import {
  AikidoPartnerStrip,
  Badge,
  Card,
  Eyebrow,
  LinkButton,
  MonoDetail,
  PageShell,
  SectionLabel,
  SeverityBar,
  StatusStrip,
  StatusStripItem,
} from "../../components";

export default function LandingPage() {
  const authed = useSignal(false);

  useEffect(() => {
    let cancelled = false;
    void sessionModel.load().then((session) => {
      if (cancelled) return;
      authed.value = Boolean(session?.user);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <PageShell
      class="gap-12"
      headerActions={
        <>
          <Show when={authed}>
            <LinkButton href="/dashboard" variant="ghost" size="sm">
              Dashboard
            </LinkButton>
          </Show>
          <LinkButton href="/docs" variant="ghost" size="sm">
            Docs
          </LinkButton>
        </>
      }
    >
      <PageSeo metadata={homePageSeo} />
      <section class="py-8 md:py-12 border-t border-border flex flex-col gap-5">
        <Eyebrow tone="accent">Pre-publish security review for npm and PyPI</Eyebrow>
        <h1 class="text-4xl md:text-5xl font-semibold tracking-[-0.03em] leading-[1.05] max-w-[760px] m-0">
          Review the exact package before it ships.
        </h1>
        <p class="text-[17px] text-ink-muted max-w-[620px] leading-[1.6] m-0">
          Code review sees source. Registries get built artifacts. Drydock pauses npm staged
          publishes and GitHub-gated PyPI or npm releases, diffs the exact bytes against the last
          published version, and pins supply-chain findings to changed lines. You make the final
          call.
        </p>
        <div class="flex gap-3 mt-2">
          <Show
            when={authed}
            fallback={
              <>
                <LinkButton href="/register">Create account</LinkButton>
                <LinkButton href="/login" variant="secondary">
                  Sign in
                </LinkButton>
              </>
            }
          >
            <LinkButton href="/dashboard">Open dashboard</LinkButton>
          </Show>
        </div>
      </section>

      <AikidoPartnerStrip />

      <ScanPreview />

      <section aria-label="Why review a publish" class="flex flex-col gap-4">
        <SectionLabel>Why review a publish</SectionLabel>
        <h2 class="text-2xl font-semibold tracking-[-0.015em] m-0 max-w-[680px]">
          Your repo review is not the release review.
        </h2>
        <div class="flex flex-col gap-3 max-w-[680px]">
          <p class="m-0 text-[14px] text-ink-muted leading-[1.65]">
            Between a reviewed pull request and a published package sit build scripts, bundlers,
            generated files, and CI credentials. Install hooks, minified bundles, and files that
            never lived in git can ship in the artifact. A stolen maintainer account or compromised
            runner can publish a malicious version without touching repository history.
          </p>
          <p class="m-0 text-[14px] text-ink-muted leading-[1.65]">
            After a version is public, it is immutable and can be installed within minutes. The last
            useful checkpoint is after the release is built and before it ships. Drydock reviews
            those exact bytes, never executes package contents, and keeps the publish blocked until
            a maintainer decides.
          </p>
        </div>
      </section>

      <section aria-label="How it works" class="flex flex-col gap-5">
        <SectionLabel>How it works</SectionLabel>
        <HowSteps
          items={[
            {
              title: "Hold the release candidate",
              body: (
                <>
                  A maintainer stages an npm publish, or a GitHub Environment gate pauses the
                  publish job after CI uploads built artifacts. The candidate stays private while
                  Drydock can inspect it.
                </>
              ),
            },
            {
              title: "Review the bytes, not the branch",
              body: (
                <>
                  Drydock compares the candidate to the last published version, flags risky deltas
                  like install scripts, process execution, network access, credential reads, and new
                  binaries, then anchors each finding to the diff. Package contents are never
                  executed.
                </>
              ),
            },
            {
              title: "Let a maintainer decide",
              body: (
                <>
                  Approve the npm publish yourself with 2FA, or approve or reject the gated GitHub
                  job from the workbench. Drydock recommends, but it never publishes and never holds
                  your publish credential.
                </>
              ),
            },
          ]}
        />
      </section>

      <section aria-label="How Drydock hooks in" class="flex flex-col gap-4">
        <SectionLabel>How it hooks in</SectionLabel>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <RegistryCard title="Staged publishing — npm">
            A maintainer runs{" "}
            <code class="font-mono text-[12px] text-ink">npm publish --stage</code> and the registry
            parks a private candidate. Drydock reviews that tarball and pins risk signals to the
            diff before the maintainer completes npm's 2FA confirmation.
          </RegistryCard>
          <RegistryCard title="Workflow gating — PyPI & npm" badge="Preview">
            For PyPI, or npm workflows that do not stage, a GitHub Environment pauses the publish
            job after CI uploads the release artifact. Drydock reviews the upload, the maintainer
            approves or rejects, and, if approved, the job continues with its own credential.
          </RegistryCard>
        </div>
        <LinkButton href="/docs" variant="ghost" size="sm" class="self-start">
          Read the docs →
        </LinkButton>
      </section>

      <section aria-label="Safeguards" class="flex flex-col gap-4">
        <SectionLabel>Safeguards</SectionLabel>
        <StatusStrip>
          <StatusStripItem label="credentials" status="scoped" tone="ok">
            Scoped tokens only fetch release evidence. Publish credentials stay in npm or GitHub
            Actions, not in Drydock.
          </StatusStripItem>
          <StatusStripItem label="retention" status="redacted" tone="ok">
            Reports keep redacted review evidence, not raw release archives.
          </StatusStripItem>
          <StatusStripItem label="approval" status="human" tone="neutral">
            Maintainers make the release decision: npm 2FA for staged publishes or the CI gate for
            workflow releases.
          </StatusStripItem>
        </StatusStrip>
      </section>
    </PageShell>
  );
}

function HowSteps({ items }: { items: Array<{ title: string; body: ComponentChildren }> }) {
  return (
    <ol class="list-none p-0 m-0 flex flex-col">
      {items.map((item, index) => (
        <li key={index} class="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3">
          <div class="flex flex-col items-center">
            <span class="font-mono text-[11px] font-medium text-ink-subtle tabular-nums leading-none pt-[3px]">
              {String(index + 1).padStart(2, "0")}
            </span>
            {index < items.length - 1 ? (
              <span class="w-px flex-1 bg-border mt-2" aria-hidden />
            ) : null}
          </div>
          <div
            class={`flex flex-col gap-1.5 min-w-0 max-w-[680px] ${
              index < items.length - 1 ? "pb-6" : ""
            }`}
          >
            <h3 class="text-base font-medium tracking-[-0.005em] m-0">{item.title}</h3>
            <p class="m-0 text-[13px] text-ink-muted leading-[1.6]">{item.body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function RegistryCard({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: string;
  children: ComponentChildren;
}) {
  return (
    <Card as="article" class="p-5 flex flex-col gap-2">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="text-base font-medium tracking-[-0.005em] m-0">{title}</h2>
        {badge ? <Badge tone="info">{badge}</Badge> : null}
      </div>
      <p class="text-[13px] text-ink-muted leading-[1.55] m-0">{children}</p>
    </Card>
  );
}

function ScanPreview() {
  return (
    <section class="flex flex-col gap-3" aria-label="Sample review">
      <SectionLabel>What a review looks like</SectionLabel>
      <Card class="p-0 overflow-hidden">
        <header class="px-5 pt-5 pb-4 border-b border-border flex flex-col gap-3">
          <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h3 class="m-0 text-lg font-semibold tracking-[-0.01em]">@acme/cli</h3>
            <span class="font-mono text-[11px] text-ink-subtle">scan_01HXY5K9PNQE3</span>
          </div>
          <MonoDetail
            parts={[
              <span key="v">4.2.0 → 4.3.0</span>,
              <span key="files">17 files</span>,
              <span key="changed">4 changed</span>,
              <span key="status">complete</span>,
            ]}
          />
          <div class="flex flex-wrap items-center gap-2">
            <Badge tone="critical">block manual approval</Badge>
            <Badge tone="critical">release critical</Badge>
            <Badge tone="medium">2 findings</Badge>
          </div>
          <SeverityBar counts={{ critical: 1, medium: 1 }} class="max-w-[420px]" />
        </header>

        <div class="grid grid-cols-1 md:grid-cols-[220px_minmax(0,1fr)] divide-y md:divide-y-0 md:divide-x divide-border">
          <aside class="p-4 flex flex-col gap-2 bg-bg/40">
            <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">
              Release tree
            </span>
            <ul class="list-none p-0 m-0 flex flex-col gap-0.5 font-mono text-[12px]">
              <TreeRow depth={0} folder open name="lib" tone="mixed" />
              <TreeRow depth={1} name="install.js" tone="added" status="added" />
              <TreeRow depth={1} name="api.js" tone="modified" status="modified" selected />
              <TreeRow depth={0} name="package.json" tone="modified" status="modified" />
              <TreeRow depth={0} name="README.md" tone="unchanged" />
              <TreeRow depth={0} name="LICENSE" tone="unchanged" />
            </ul>
          </aside>

          <div class="flex flex-col min-w-0">
            <div class="px-4 py-2 bg-surface-2 flex flex-wrap items-center justify-between gap-2 border-b border-border">
              <div class="flex items-center gap-2 min-w-0">
                <Badge tone="modified">modified</Badge>
                <code class="font-mono text-xs text-ink-muted truncate">package.json</code>
              </div>
              <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">
                4.2.0 → 4.3.0
              </span>
            </div>

            <div class="overflow-x-auto">
              <table class="w-full border-collapse font-mono text-[12px] leading-[1.55]">
                <tbody>
                  <DiffLine tone="unchanged" before={3} after={3} text='  "version": "4.3.0",' />
                  <DiffLine
                    tone="unchanged"
                    before={4}
                    after={4}
                    text='  "main": "lib/index.js",'
                  />
                  <DiffLine tone="unchanged" before={5} after={5} text='  "scripts": {' />
                  <DiffLine tone="unchanged" before={6} after={6} text='    "build": "tsc -p .",' />
                  <DiffLine
                    tone="added"
                    before={null}
                    after={7}
                    text='    "postinstall": "node lib/install.js",'
                  />
                  <DiffLine tone="unchanged" before={7} after={8} text='    "test": "vitest"' />
                  <DiffLine tone="unchanged" before={8} after={9} text="  }," />
                </tbody>
              </table>
            </div>

            <FindingAnnotation />
          </div>
        </div>
      </Card>
    </section>
  );
}

function TreeRow({
  depth,
  name,
  tone,
  status,
  folder,
  open,
  selected,
}: {
  depth: number;
  name: string;
  tone: "added" | "removed" | "modified" | "unchanged" | "mixed";
  status?: "added" | "removed" | "modified";
  folder?: boolean;
  open?: boolean;
  selected?: boolean;
}) {
  const toneClass =
    tone === "added"
      ? "text-ok-text"
      : tone === "removed"
        ? "text-danger-text"
        : tone === "modified"
          ? "text-warn-text"
          : tone === "mixed"
            ? "text-accent"
            : "text-ink-muted";
  return (
    <li
      class={`flex items-center gap-2 py-0.5 pr-1.5 rounded ${
        selected ? "bg-surface-2 text-ink" : toneClass
      }`}
      style={{ paddingLeft: `${4 + depth * 16}px` }}
    >
      {folder ? (
        <span aria-hidden class="text-[10px] text-ink-subtle">
          {open ? "▾" : "▸"}
        </span>
      ) : (
        <span class="w-[10px]" aria-hidden />
      )}
      <span class={`flex-1 truncate ${selected ? "text-ink" : ""}`}>
        {name}
        {folder ? "/" : ""}
      </span>
      {status ? <Badge tone={status}>{status}</Badge> : null}
    </li>
  );
}

function DiffLine({
  tone,
  before,
  after,
  text,
}: {
  tone: "added" | "removed" | "unchanged";
  before: number | null;
  after: number | null;
  text: string;
}) {
  const bg = tone === "added" ? "bg-ok-soft" : tone === "removed" ? "bg-danger-soft" : "";
  const sign = tone === "added" ? "+" : tone === "removed" ? "-" : " ";
  return (
    <tr class={bg}>
      <td class="px-2 py-[2px] text-ink-subtle select-none w-[44px] text-right border-r border-border align-top">
        {before ?? ""}
      </td>
      <td class="px-2 py-[2px] text-ink-subtle select-none w-[44px] text-right border-r border-border align-top">
        {after ?? ""}
      </td>
      <td class="px-2 py-[2px] select-none w-[20px] text-ink-subtle align-top">{sign}</td>
      <td class="px-2 py-[2px] whitespace-pre-wrap break-words align-top">{text}</td>
    </tr>
  );
}

function FindingAnnotation() {
  return (
    <div class="border-t border-border px-4 py-3 flex flex-col gap-1.5 bg-danger-soft/40">
      <div class="flex items-center gap-2 flex-wrap">
        <Badge tone="critical">critical</Badge>
        <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">
          lifecycle script added · line 7
        </span>
      </div>
      <p class="m-0 text-[13px] leading-[1.55] text-ink">
        <code class="font-mono text-[12px] text-ink-muted">postinstall</code> now executes during{" "}
        <code class="font-mono text-[12px] text-ink-muted">npm install</code>, invoking{" "}
        <code class="font-mono text-[12px] text-ink-muted">lib/install.js</code>, a newly added file
        in this release. Inspect before approving.
      </p>
    </div>
  );
}
