import type { ComponentChildren } from "preact";
import { useComputed, useSignal, type ReadonlySignal, type Signal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { useLayoutEffect, useRef } from "preact/hooks";
import { homePageSeo, PageSeo, StructuredData } from "../../lib/seo";
import { AikidoPartnerStrip } from "../../components/AikidoPartner";
import { Badge } from "../../components/Badge";
import { LinkButton } from "../../components/Button";
import { Card } from "../../components/Card";
import { PageShell } from "../../components/PageShell";
import { SeverityBar } from "../../components/SeverityBar";
import { StatusStrip, StatusStripItem } from "../../components/StatusStrip";
import { Eyebrow, LoadingLine, MonoDetail, SectionLabel } from "../../components/Typography";
import { MarketingHeaderActions } from "../MarketingHeaderActions";
import { useAuthedSession } from "../useAuthedSession";

export default function LandingPage() {
  const authed = useAuthedSession();

  return (
    <PageShell
      class="gap-14 lg:gap-16"
      headerActions={<MarketingHeaderActions authed={authed} />}
      feedbackPosition="end"
    >
      <PageSeo metadata={homePageSeo} />
      <StructuredData />

      <section class="border-t border-border py-10 md:py-14 flex flex-col gap-5">
        <Eyebrow tone="accent">Pre-publish artifact review</Eyebrow>
        <h1 class="m-0 max-w-[760px] text-4xl font-semibold leading-[1.05] tracking-[-0.03em] md:text-5xl">
          Malware doesn't get committed. It gets published.
        </h1>
        <p class="m-0 max-w-[620px] text-[17px] leading-[1.6] text-ink-muted">
          Stolen tokens, phished maintainers, and compromised CI ship straight to the registry — the
          malicious change never appears in a pull request. Drydock holds the release and reviews
          the exact artifact before anyone can install it.
        </p>
        <div class="mt-1 flex flex-wrap gap-3">
          <Show
            when={authed}
            fallback={<LinkButton href="/register">Start reviewing releases</LinkButton>}
          >
            <LinkButton href="/dashboard">Open dashboard</LinkButton>
          </Show>
          <LinkButton href="/docs" variant="secondary">
            Read the docs
          </LinkButton>
        </div>
        <MonoDetail
          class="mt-1"
          parts={[
            <span key="npm">npm stage publish</span>,
            <span key="gates">GitHub workflow gates</span>,
            <span key="oss">free for open source</span>,
          ]}
        />
      </section>

      <IncidentRecord />

      <Checkpoint />

      <ReviewProof />

      <DeterministicCoverage />

      <IntegrationPaths />

      <TrustContract />

      <FreeForOpenSource />

      <ClosingCta authed={authed} />
    </PageShell>
  );
}

/* ------------------------------------------------------------------ */
/* The record — documented incidents where the artifact was the attack */
/* ------------------------------------------------------------------ */

interface Incident {
  name: string;
  date: string;
  summary: string;
  hidIn: string;
}

const INCIDENTS: Incident[] = [
  {
    name: "eslint-scope@3.7.2",
    date: "Jul 2018",
    summary:
      "A stolen npm token published a version whose install hook pulled a payload from pastebin and exfiltrated npm credentials.",
    hidIn: 'package.json › "postinstall"',
  },
  {
    name: "flatmap-stream@0.1.1",
    date: "Nov 2018",
    summary:
      "A new event-stream dependency carried an encrypted payload targeting a bitcoin wallet's release build.",
    hidIn: "minified bundle · npm tarball only",
  },
  {
    name: "ua-parser-js@0.7.29",
    date: "Oct 2021",
    summary:
      "A hijacked maintainer account shipped a preinstall script that dropped a cryptominer and a credential stealer.",
    hidIn: "preinstall.js",
  },
  {
    name: "xz-utils 5.6.0",
    date: "Mar 2024",
    summary:
      "The backdoor's build-time loader existed only in the release tarball — it was never committed to the repository.",
    hidIn: "build-to-host.m4 · tarball only",
  },
  {
    name: "ultralytics@8.3.41",
    date: "Dec 2024",
    summary:
      "A poisoned GitHub Actions workflow injected a cryptominer into the wheel during the build. The tagged source stayed clean.",
    hidIn: "PyPI wheel · built in CI",
  },
  {
    name: "chalk@5.6.1 + 17 packages",
    date: "Sep 2025",
    summary:
      "A phishing email reset one maintainer's 2FA; a browser crypto-clipper shipped in packages with two billion weekly downloads.",
    hidIn: "bundled source · injected pre-publish",
  },
  {
    name: "Shai-Hulud worm",
    date: "Sep 2025",
    summary:
      "A self-replicating install hook harvested credentials and republished itself into every package its victims could publish — hundreds of packages within days.",
    hidIn: "bundle.js › postinstall",
  },
];

function IncidentRecord() {
  return (
    <section aria-labelledby="record-title" class="flex flex-col gap-5">
      <SectionLabel>The record</SectionLabel>
      <div class="flex max-w-[680px] flex-col gap-3">
        <h2 id="record-title" class="m-0 text-2xl font-semibold leading-[1.25] tracking-[-0.015em]">
          The repository looked clean every time.
        </h2>
        <p class="m-0 text-[14px] leading-[1.65] text-ink-muted">
          Seven incidents, three ecosystems, one pattern: the attack lived in the published
          artifact, where nobody was looking.
        </p>
      </div>
      <Card padding="none" class="overflow-hidden">
        <ul class="m-0 list-none divide-y divide-border p-0">
          {INCIDENTS.map((incident) => (
            <li
              key={incident.name}
              class="grid grid-cols-1 gap-x-6 gap-y-1.5 px-5 py-4 md:grid-cols-[230px_minmax(0,1fr)]"
            >
              <div class="flex flex-col gap-0.5">
                <code class="font-mono text-[13px] font-medium text-ink">{incident.name}</code>
                <span class="font-mono text-[11px] text-ink-subtle">{incident.date}</span>
              </div>
              <div class="flex min-w-0 flex-col gap-1.5">
                <p class="m-0 text-[13px] leading-[1.55] text-ink-muted">{incident.summary}</p>
                <p class="m-0 font-mono text-[11px] text-ink-subtle">
                  <span class="uppercase tracking-[0.1em]">hid in</span>{" "}
                  <span class="text-ink-muted">{incident.hidIn}</span>
                </p>
              </div>
            </li>
          ))}
        </ul>
        <p class="m-0 border-t border-l-2 border-t-border border-l-accent bg-accent-soft px-5 py-4 text-[13px] leading-[1.55] text-ink">
          In every case the published artifact was the only place the attack was visible. That is
          the review Drydock adds.
        </p>
      </Card>
    </section>
  );
}

/* --------------------------------------------- */
/* The checkpoint — hold → review → decide steps  */
/* --------------------------------------------- */

function Checkpoint() {
  return (
    <section aria-labelledby="checkpoint-title" class="flex flex-col gap-5">
      <SectionLabel>The checkpoint</SectionLabel>
      <h2
        id="checkpoint-title"
        class="m-0 max-w-[680px] text-2xl font-semibold leading-[1.25] tracking-[-0.015em]"
      >
        Hold the release. Read the diff. Then decide.
      </h2>
      <HowSteps
        items={[
          {
            title: "Hold",
            body: (
              <>
                A maintainer runs{" "}
                <code class="font-mono text-[12px] text-ink">npm stage publish</code>, or a GitHub
                Environment gate pauses the publish job after CI uploads the built artifact. The
                candidate stays private — nothing ships yet.
              </>
            ),
          },
          {
            title: "Review",
            body: (
              <>
                Drydock diffs the candidate against the last published version and pins every
                finding to the changed line that triggered it. Package code is never executed.
              </>
            ),
          },
          {
            title: "Decide",
            body: (
              <>
                You approve the npm publish with your own 2FA, or resolve the GitHub gate from the
                workbench. Drydock never holds a publish credential and cannot publish.
              </>
            ),
          },
        ]}
      />
    </section>
  );
}

function HowSteps({ items }: { items: Array<{ title: string; body: ComponentChildren }> }) {
  return (
    <ol class="m-0 flex list-none flex-col p-0">
      {items.map((item, index) => (
        <li key={item.title} class="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3">
          <div class="flex flex-col items-center">
            <span class="pt-[3px] font-mono text-[11px] font-medium leading-none tabular-nums text-ink-subtle">
              {String(index + 1).padStart(2, "0")}
            </span>
            {index < items.length - 1 ? (
              <span class="mt-2 w-px flex-1 bg-border" aria-hidden />
            ) : null}
          </div>
          <div
            class={`flex min-w-0 max-w-[680px] flex-col gap-1.5 ${
              index < items.length - 1 ? "pb-6" : ""
            }`}
          >
            <h3 class="m-0 text-base font-medium tracking-[-0.005em]">{item.title}</h3>
            <p class="m-0 text-[13px] leading-[1.6] text-ink-muted">{item.body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------------- */
/* Product proof — a held release whose scan plays once, on first view  */
/* ------------------------------------------------------------------- */

type ScanStage = "done" | "waiting" | "scanning";

function ReviewProof() {
  // "done" is the default so prerendered HTML, no-JS visitors, and
  // prefers-reduced-motion all get the finished report. The client-only
  // effect below downgrades to "waiting" and plays the scan exactly once
  // when the card first scrolls into view.
  const stage = useSignal<ScanStage>("done");
  const cardRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    stage.value = "waiting";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        stage.value = "scanning";
        timer = setTimeout(() => {
          stage.value = "done";
        }, 900);
      },
      { threshold: 0.2 },
    );
    observer.observe(card);
    return () => {
      observer.disconnect();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [stage]);

  const scanned = useComputed(() => stage.value === "done");

  return (
    <section aria-labelledby="proof-title" class="flex flex-col gap-5">
      <SectionLabel>What you review</SectionLabel>
      <div class="flex max-w-[680px] flex-col gap-3">
        <h2 id="proof-title" class="m-0 text-2xl font-semibold leading-[1.25] tracking-[-0.015em]">
          The review those releases never got.
        </h2>
        <p class="m-0 text-[14px] leading-[1.65] text-ink-muted">
          This is the diff a maintainer sees while the release is held: version 4.3.0 quietly adds
          an install hook. The finding is pinned to the line that changed.
        </p>
      </div>

      <div ref={cardRef}>
        <Card as="article" padding="none" class="overflow-hidden">
          <header class="flex flex-col gap-3 border-b border-border px-5 pb-4 pt-5">
            <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h3 class="m-0 text-lg font-semibold tracking-[-0.01em]">@acme/cli</h3>
              <span class="font-mono text-[11px] text-ink-subtle">scan_01HXY5K9PNQE3</span>
            </div>
            <Show
              when={scanned}
              fallback={<LoadingLine size="inline">Reading 17 files against 4.2.0</LoadingLine>}
            >
              <MonoDetail
                parts={[
                  <span key="v">4.2.0 → 4.3.0</span>,
                  <span key="files">17 files</span>,
                  <span key="changed">4 changed</span>,
                  <span key="status">complete</span>,
                ]}
              />
            </Show>
            <Reveal stage={stage} delayMs={500} class="flex flex-col gap-3">
              <div class="flex flex-wrap items-center gap-2">
                <Badge tone="critical">release critical</Badge>
                <Badge tone="medium">2 findings</Badge>
              </div>
              <SeverityBar counts={{ critical: 1, medium: 1 }} class="max-w-[420px]" />
            </Reveal>
          </header>

          <Reveal stage={stage} delayMs={0}>
            <div class="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-2 px-4 py-2">
              <div class="flex min-w-0 items-center gap-2">
                <Badge tone="modified">modified</Badge>
                <code class="truncate font-mono text-xs text-ink-muted">package.json</code>
              </div>
              <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">
                4.2.0 → 4.3.0
              </span>
            </div>
            <div class="overflow-x-auto">
              <table class="w-full border-collapse font-mono text-[12px] leading-[1.55]">
                <tbody>
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
          </Reveal>

          <Reveal stage={stage} delayMs={250}>
            <div class="flex flex-col gap-1.5 border-t border-l-2 border-t-border border-l-danger bg-danger-soft/40 px-4 py-3">
              <div class="flex flex-wrap items-center gap-2">
                <Badge tone="critical">critical</Badge>
                <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">
                  install-script.lifecycle · line 7
                </span>
              </div>
              <p class="m-0 text-[13px] leading-[1.55] text-ink">
                <code class="font-mono text-[12px] text-ink-muted">postinstall</code> now runs on
                every consumer install, invoking{" "}
                <code class="font-mono text-[12px] text-ink-muted">lib/install.js</code> — a file
                that is new in this release.
              </p>
            </div>
          </Reveal>

          <Reveal stage={stage} delayMs={650}>
            <div class="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-4">
              <div class="flex min-w-0 flex-col gap-1">
                <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
                  recommendation
                </span>
                <p class="m-0 text-[13px] leading-[1.55] text-ink">
                  Block publish until the new install path is explained. The release stays held.
                </p>
              </div>
              <Badge tone="critical">block publish</Badge>
            </div>
          </Reveal>
        </Card>
      </div>
    </section>
  );
}

// Literal class strings so Tailwind's scanner emits them; inline style
// attributes are off the table entirely (CSP style-src-attr 'none').
const REVEAL_DELAY_CLASS = {
  0: "delay-[0ms]",
  250: "delay-[250ms]",
  500: "delay-[500ms]",
  650: "delay-[650ms]",
} as const;

function Reveal({
  stage,
  delayMs,
  class: className,
  children,
}: {
  stage: ReadonlySignal<ScanStage>;
  delayMs: keyof typeof REVEAL_DELAY_CLASS;
  class?: string;
  children: ComponentChildren;
}) {
  const revealClass = useComputed(() =>
    stage.value === "done"
      ? `opacity-100 transition-opacity duration-[250ms] ease-out ${REVEAL_DELAY_CLASS[delayMs]} ${className ?? ""}`
      : `opacity-0 transition-none ${className ?? ""}`,
  );
  return <div class={revealClass}>{children}</div>;
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
      <td class="w-[44px] select-none border-r border-border px-2 py-[2px] text-right align-top text-ink-subtle">
        {before ?? ""}
      </td>
      <td class="w-[44px] select-none border-r border-border px-2 py-[2px] text-right align-top text-ink-subtle">
        {after ?? ""}
      </td>
      <td class="w-[20px] select-none px-2 py-[2px] align-top text-ink-subtle">{sign}</td>
      <td class="whitespace-pre-wrap break-words px-2 py-[2px] align-top">{text}</td>
    </tr>
  );
}

/* ---------------------------------------------------- */
/* Deterministic coverage — real rule IDs, real attacks  */
/* ---------------------------------------------------- */

const RULE_FAMILIES = [
  {
    rules: "install-script.preinstall · lifecycle · implicit-node-gyp",
    body: "New lifecycle hooks — how eslint-scope, ua-parser-js, and Shai-Hulud ran on install.",
  },
  {
    rules: "code.credential-access · code.network-access",
    body: "Shipped code that starts reading tokens or phoning home.",
  },
  {
    rules: "code.process-execution · code.dynamic-evaluation",
    body: "New shells, child processes, and eval-style execution in changed files.",
  },
  {
    rules: "diff.bin-added · file.native-artifact · file.large-binary",
    body: "Executables and opaque payloads that appear in a release.",
  },
  {
    rules: "file.secret-content · diff.credential-file-added",
    body: "Secrets and credential files accidentally packed into the artifact.",
  },
  {
    rules: "stage.metadata-mismatch · tar.suspicious-entry · dependency.unusual-spec",
    body: "Archive tricks, identity mismatches, and dependency drift.",
  },
];

function DeterministicCoverage() {
  return (
    <section aria-labelledby="coverage-title" class="flex flex-col gap-5">
      <SectionLabel>Deterministic findings</SectionLabel>
      <div class="flex max-w-[680px] flex-col gap-3">
        <h2
          id="coverage-title"
          class="m-0 text-2xl font-semibold leading-[1.25] tracking-[-0.015em]"
        >
          Checks that map to real attacks.
        </h2>
        <p class="m-0 text-[14px] leading-[1.65] text-ink-muted">
          The deterministic ruleset covers the ways registries have actually been attacked. AI
          review is advisory — it can add context, never downgrade a finding.
        </p>
      </div>
      <Card padding="none" class="overflow-hidden">
        <dl class="m-0 divide-y divide-border">
          {RULE_FAMILIES.map((family) => (
            <div
              key={family.rules}
              class="grid grid-cols-1 gap-x-6 gap-y-1 px-5 py-3.5 md:grid-cols-[minmax(0,420px)_minmax(0,1fr)] md:items-baseline"
            >
              <dt class="font-mono text-[12px] font-medium text-ink">{family.rules}</dt>
              <dd class="m-0 text-[13px] leading-[1.55] text-ink-muted">{family.body}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </section>
  );
}

/* -------------------------------------------- */
/* Integration — the two ways to hold a release  */
/* -------------------------------------------- */

function IntegrationPaths() {
  return (
    <section aria-labelledby="integration-title" class="flex flex-col gap-5">
      <SectionLabel>Integration</SectionLabel>
      <h2
        id="integration-title"
        class="m-0 max-w-[680px] text-2xl font-semibold leading-[1.25] tracking-[-0.015em]"
      >
        Meet your release where it can still stop.
      </h2>
      <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
        <IntegrationCard
          title="npm stage publish"
          command="npm stage publish"
          fields={[
            { label: "best for", value: "npm packages, zero CI changes" },
            { label: "held by", value: "the npm registry, as a private candidate" },
            { label: "decision", value: "maintainer completes the publish with 2FA" },
          ]}
        >
          The registry parks the exact tarball privately. Drydock reviews it against the last
          published version; approval stays in npm.
        </IntegrationCard>
        <IntegrationCard
          title="GitHub workflow gate"
          command="build → upload → gate → publish"
          badge="Preview"
          fields={[
            { label: "best for", value: "PyPI, VS Code, and npm CI workflows" },
            { label: "held by", value: "a GitHub Environment protection rule" },
            { label: "decision", value: "approve or reject the gated job from Drydock" },
          ]}
        >
          The publish job pauses after CI uploads the built artifact. Drydock reviews the upload and
          posts the maintainer's decision back to GitHub.
        </IntegrationCard>
      </div>
      <LinkButton href="/docs" variant="ghost" size="sm" class="self-start">
        Read the setup guides →
      </LinkButton>
    </section>
  );
}

function IntegrationCard({
  title,
  command,
  badge,
  fields,
  children,
}: {
  title: string;
  command: string;
  badge?: string;
  fields: Array<{ label: string; value: string }>;
  children: ComponentChildren;
}) {
  return (
    <Card as="article" padding="compact" class="flex flex-col gap-4">
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="m-0 text-base font-medium tracking-[-0.005em]">{title}</h3>
        {badge ? <Badge tone="info">{badge}</Badge> : null}
      </div>
      <code class="overflow-x-auto rounded border border-border bg-surface-2 px-3 py-2.5 font-mono text-[12px] text-ink">
        {command}
      </code>
      <p class="m-0 text-[13px] leading-[1.55] text-ink-muted">{children}</p>
      <dl class="m-0 mt-auto flex flex-col gap-2 border-t border-border pt-3">
        {fields.map((field) => (
          <div key={field.label} class="grid grid-cols-[84px_minmax(0,1fr)] gap-3">
            <dt class="font-mono text-[11px] uppercase leading-[1.5] tracking-[0.1em] text-ink-subtle">
              {field.label}
            </dt>
            <dd class="m-0 text-[13px] leading-[1.5] text-ink">{field.value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/* ------------------- */
/* Trust and who pays  */
/* ------------------- */

function TrustContract() {
  return (
    <section aria-label="The trust contract" class="flex flex-col gap-5">
      <SectionLabel>The trust contract</SectionLabel>
      <StatusStrip>
        <StatusStripItem label="package code" status="never executed" tone="ok">
          Artifacts are parsed as hostile evidence. No installs, no lifecycle scripts, no rendering.
        </StatusStripItem>
        <StatusStripItem label="publish credentials" status="never held" tone="ok">
          Publishing stays in npm or your CI. Drydock's tokens only read release evidence.
        </StatusStripItem>
        <StatusStripItem label="final call" status="human" tone="neutral">
          Every held release is resolved by a maintainer, with the evidence in front of them.
        </StatusStripItem>
      </StatusStrip>
    </section>
  );
}

function FreeForOpenSource() {
  return (
    <section aria-labelledby="oss-title" class="flex flex-col gap-5">
      <SectionLabel>Who pays</SectionLabel>
      <div class="flex max-w-[680px] flex-col gap-3">
        <h2 id="oss-title" class="m-0 text-2xl font-semibold leading-[1.25] tracking-[-0.015em]">
          Free for open-source maintainers.
        </h2>
        <p class="m-0 text-[14px] leading-[1.65] text-ink-muted">
          The people maintaining the packages everyone installs shouldn't pay to protect them.
          Reviewing open-source releases with Drydock is free, and sponsorship helps keep it that
          way.
        </p>
      </div>
      <AikidoPartnerStrip />
    </section>
  );
}

function ClosingCta({ authed }: { authed: Signal<boolean> }) {
  return (
    <Card class="flex flex-col items-start gap-5 border-border-strong md:p-8">
      <Eyebrow tone="accent">Your next release</Eyebrow>
      <div class="flex max-w-[760px] flex-col gap-3">
        <h2 class="m-0 text-2xl font-semibold leading-[1.25] tracking-[-0.015em]">
          The next version you publish can be a reviewed one.
        </h2>
        <p class="m-0 max-w-[620px] text-[14px] leading-[1.65] text-ink-muted">
          Stage an npm publish or gate a release workflow — either way, you read the diff before
          anyone can install it.
        </p>
      </div>
      <div class="flex flex-wrap gap-3">
        <Show
          when={authed}
          fallback={<LinkButton href="/register">Start reviewing releases</LinkButton>}
        >
          <LinkButton href="/dashboard">Open dashboard</LinkButton>
        </Show>
        <LinkButton href="/docs" variant="secondary">
          Read the docs
        </LinkButton>
      </div>
    </Card>
  );
}
