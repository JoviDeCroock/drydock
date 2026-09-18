import type { ComponentChildren } from "preact";
import { Show } from "@preact/signals/utils";
import { homePageSeo, PageSeo, StructuredData } from "../../lib/seo";
import { AikidoPartnerStrip } from "../../components/AikidoPartner";
import { Badge } from "../../components/Badge";
import { LinkButton } from "../../components/Button";
import { Card } from "../../components/Card";
import { PageShell } from "../../components/PageShell";
import { StatusStrip, StatusStripItem } from "../../components/StatusStrip";
import { MonoDetail, SectionLabel } from "../../components/Typography";
import { IncidentDiffCards } from "../../features/incident-diffs/IncidentDiffCards";
import { DependencyPrIntegrations } from "../../features/dependency-pr-integrations/DependencyPrIntegrations";
import { MarketingHeaderActions } from "../MarketingHeaderActions";
import { useAuthedSession } from "../useAuthedSession";
import { ScanPreview } from "./ScanPreview";

export default function LandingPage() {
  const authed = useAuthedSession();

  return (
    <PageShell
      class="gap-12"
      headerActions={<MarketingHeaderActions authed={authed} />}
      feedbackPosition="end"
    >
      <PageSeo metadata={homePageSeo} />
      <StructuredData />
      <section class="py-8 md:py-12 border-t border-border flex flex-col gap-5">
        <h1 class="text-4xl md:text-5xl font-semibold tracking-[-0.03em] leading-[1.05] max-w-[760px] m-0">
          Review the package artifact before it ships.
        </h1>
        <p class="text-[17px] text-ink-muted max-w-[620px] leading-[1.6] m-0">
          Between your last code review and the public registry sit build scripts, bundler output,
          and CI credentials. Drydock diffs the exact artifact against the last published version
          and pins every supply-chain finding to a changed line. Workflow Gate enforces the decision
          on a configured protected job; Stage Watchtower records an advisory npm review.
        </p>
        <MonoDetail
          parts={[
            "Stage Watchtower — advisory",
            "Workflow Gate — enforced",
            "no publish credential",
          ]}
        />
        <div class="flex flex-wrap gap-3 mt-2">
          <Show
            when={authed}
            fallback={
              <>
                <LinkButton href="/diff">Read a diff</LinkButton>
                <LinkButton href="/register" variant="secondary">
                  Create account
                </LinkButton>
                <LinkButton href="/login" variant="ghost">
                  Sign in
                </LinkButton>
              </>
            }
          >
            <LinkButton href="/dashboard">Open dashboard</LinkButton>
          </Show>
        </div>
      </section>

      <ScanPreview />

      <section aria-label="Live incident diffs" class="flex flex-col gap-3">
        <SectionLabel as="h2">Open a live diff</SectionLabel>
        <p class="m-0 text-[13px] text-ink-muted leading-[1.55] max-w-[680px]">
          The report above is hand-authored. These are live reports from the same deterministic
          review — two real supply-chain incidents and one demo package. No account needed.
        </p>
        <IncidentDiffCards />
        <LinkButton href="/diff" variant="ghost" size="sm" class="self-start">
          Diff any npm, PyPI, or atpm package →
        </LinkButton>
      </section>

      <DependencyPrIntegrations />

      <AikidoPartnerStrip />

      <section aria-label="Why review a publish" class="flex flex-col gap-4">
        <SectionLabel as="p">Why review a publish</SectionLabel>
        <h2 class="text-2xl font-semibold tracking-[-0.015em] m-0 max-w-[680px]">
          The attacks that matter ship in the artifact.
        </h2>
        <p class="m-0 text-[14px] text-ink-muted leading-[1.65] max-w-[680px]">
          A pull request review checks the source tree. The registry serves something else: a built
          artifact that can carry install hooks, minified bundles, and files that never lived in
          git, published with a credential that may not belong to the person you think. Once a
          version is live it is immutable and installed within minutes. The last useful checkpoint
          sits between the finished artifact and the registry — and that is the one almost nobody
          looks at.
        </p>
        <IncidentLog />
      </section>

      <section aria-label="How it works" class="flex flex-col gap-5">
        <SectionLabel as="h2">How it works</SectionLabel>
        <HowSteps
          items={[
            {
              title: "Pause or watch the release candidate",
              body: (
                <>
                  Stage Watchtower observes a private npm staged artifact without controlling it.
                  Workflow Gate uses a GitHub Environment to pause the configured protected publish
                  job after CI uploads built artifacts.
                </>
              ),
            },
            {
              title: "Review the artifact, not the branch",
              body: (
                <>
                  Drydock compares the candidate with the last published version, flags risky deltas
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
                  job from the workbench. Drydock gives you the review; it never publishes and never
                  holds your publish credential.
                </>
              ),
            },
          ]}
        />
      </section>

      <section aria-label="How Drydock hooks in" class="flex flex-col gap-4">
        <SectionLabel as="h2">How it hooks in</SectionLabel>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <RegistryCard title="Stage Watchtower — advisory">
            A maintainer runs <code class="font-mono text-[12px] text-ink">npm stage publish</code>{" "}
            and the registry parks a private candidate. Drydock reviews that tarball and pins risk
            signals to the diff. The maintainer independently approves or rejects in npm with 2FA;
            Drydock cannot stop a separate manual publish.
          </RegistryCard>
          <RegistryCard title="Workflow Gate — enforced: PyPI, npm & VS Code" badge="Preview">
            For PyPI, VS Code extensions, or npm workflows that do not stage, a GitHub Environment
            pauses the publish job after CI uploads the release artifact. Drydock reviews the
            upload, the maintainer approves or rejects, and, if approved, the job continues with its
            own credential.
          </RegistryCard>
        </div>
        <LinkButton href="/docs" variant="ghost" size="sm" class="self-start">
          Read the docs →
        </LinkButton>
      </section>

      <section aria-label="Safeguards" class="flex flex-col gap-4">
        <SectionLabel as="h2">Safeguards</SectionLabel>
        <StatusStrip>
          <StatusStripItem label="credentials" status="scoped" tone="ok">
            Scoped tokens only fetch release evidence. Publish credentials stay in npm or GitHub
            Actions, not in Drydock.
          </StatusStripItem>
          <StatusStripItem label="retention" status="redacted" tone="ok">
            Reports keep redacted review evidence instead of raw release archives.
          </StatusStripItem>
          <StatusStripItem label="approval" status="human" tone="neutral">
            Maintainers make the release decision: npm 2FA for a stage publish or the CI gate for
            workflow releases.
          </StatusStripItem>
        </StatusStrip>
      </section>

      <section aria-label="Get started" class="flex flex-col gap-4">
        <SectionLabel as="p">Get started</SectionLabel>
        <h2 class="text-[32px] font-semibold tracking-[-0.02em] leading-[1.15] m-0 max-w-[680px]">
          Put your next release in the dock.
        </h2>
        <p class="m-0 text-[14px] text-ink-muted leading-[1.65] max-w-[620px]">
          Watch an npm stage or add an enforced workflow gate to a protected release job. Setup
          takes minutes, and each configured release path gets a second pair of eyes before
          publication.
        </p>
        <div class="flex gap-3 mt-1">
          <Show
            when={authed}
            fallback={
              <>
                <LinkButton href="/register">Create account</LinkButton>
                <LinkButton href="/docs" variant="secondary">
                  Read the docs
                </LinkButton>
              </>
            }
          >
            <LinkButton href="/dashboard">Open dashboard</LinkButton>
          </Show>
        </div>
        <MonoDetail parts={["read-only tokens", "you keep the final approval"]} />
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
    <Card as="article" padding="compact" class="flex flex-col gap-2">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="text-base font-medium tracking-[-0.005em] m-0">{title}</h2>
        {badge ? <Badge tone="info">{badge}</Badge> : null}
      </div>
      <p class="text-[13px] text-ink-muted leading-[1.55] m-0">{children}</p>
    </Card>
  );
}

/* ---------------------------------------------------------------- *
 * Incident log — the publish-time attacks the artifact gap enabled *
 * ---------------------------------------------------------------- */

const INCIDENTS: Array<{ name: string; year: string; vector: string; shipped: string }> = [
  {
    name: "event-stream",
    year: "2018",
    vector: "publish rights handed over",
    shipped:
      "A volunteer co-maintainer published a wallet-drainer aimed at Copay. The payload existed only in the npm tarball — the GitHub repository never showed it.",
  },
  {
    name: "ua-parser-js",
    year: "2021",
    vector: "hijacked npm account",
    shipped:
      "Three malicious versions carried a cryptominer and a credential stealer. The repository was untouched; only the published artifacts were compromised.",
  },
  {
    name: "node-ipc",
    year: "2022",
    vector: "maintainer's own publish",
    shipped:
      "A legitimate credential shipped a payload that overwrote files based on the installer's IP address. Nothing about the account looked wrong.",
  },
  {
    name: "chalk & debug",
    year: "2025",
    vector: "phished maintainer",
    shipped:
      "One phishing email compromised 18 packages with about two billion combined weekly downloads. The crypto-stealing versions were live for hours before anyone diffed them.",
  },
];

function IncidentLog() {
  return (
    <Card as="div" padding="none" class="overflow-hidden">
      <ul class="list-none m-0 p-0">
        {INCIDENTS.map((incident) => (
          <li
            key={incident.name}
            class="border-b border-border grid grid-cols-1 md:grid-cols-[220px_minmax(0,1fr)] gap-x-6 gap-y-1.5 px-5 py-4"
          >
            <div class="flex flex-col gap-1 min-w-0">
              <span class="font-mono text-[13px] text-ink">{incident.name}</span>
              <MonoDetail parts={[incident.year, incident.vector]} />
            </div>
            <p class="m-0 text-[13px] text-ink-muted leading-[1.55]">{incident.shipped}</p>
          </li>
        ))}
      </ul>
      <p class="m-0 px-5 py-4 text-[13px] leading-[1.55] text-ink">
        None of these appeared in a pull request. Every one shipped through a publish nobody
        reviewed.
      </p>
    </Card>
  );
}
