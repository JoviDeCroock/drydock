import type { ComponentChildren } from "preact";
import { Show } from "@preact/signals/utils";
import { homePageSeo, PageSeo, StructuredData } from "../../lib/seo";
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
import { LandingTrustStrip } from "./LandingTrustStrip";

export default function LandingPage() {
  const authed = useAuthedSession();

  return (
    <PageShell class="gap-12" headerActions={<MarketingHeaderActions authed={authed} />}>
      <PageSeo metadata={homePageSeo} />
      <StructuredData />
      <section class="py-8 md:py-12 border-t border-border flex flex-col gap-5">
        <h1 class="text-4xl md:text-5xl font-semibold tracking-[-0.03em] leading-[1.05] max-w-[760px] m-0">
          Review your package before you publish.
        </h1>
        <p class="text-[17px] text-ink-muted max-w-[620px] leading-[1.6] m-0">
          Compare your built npm, PyPI, or VS Code release with the previous version. Drydock shows
          changed files and supply-chain findings so you can inspect unexpected behavior before
          publication.
        </p>
        <MonoDetail
          parts={[
            "Workflow Gate — enforced",
            "Stage Watchtower — advisory",
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
            <LinkButton href="/dashboard">Open reviews</LinkButton>
          </Show>
        </div>
      </section>

      <div class="flex flex-col gap-5">
        <DependencyPrIntegrations compact />
        <LandingTrustStrip />
      </div>

      <ScanPreview />

      <section aria-label="Live incident diffs" class="flex flex-col gap-3">
        <SectionLabel as="h2">Open a live diff</SectionLabel>
        <p class="m-0 text-[13px] text-ink-muted leading-[1.55] max-w-[680px]">
          Try the review on two real supply-chain incidents or a demo package. These reports run
          Drydock's checks on the published artifacts; the preview above uses example data.
        </p>
        <IncidentDiffCards />
        <LinkButton href="/diff" variant="ghost" size="sm" class="self-start">
          Diff a package →
        </LinkButton>
      </section>

      <section aria-label="Why review the package" class="flex flex-col gap-4">
        <SectionLabel as="p">Why review the package</SectionLabel>
        <h2 class="text-2xl font-semibold tracking-[-0.015em] m-0 max-w-[680px]">
          Packaging can introduce changes a pull request never showed.
        </h2>
        <p class="m-0 text-[14px] text-ink-muted leading-[1.65] max-w-[680px]">
          Build output, bundled dependencies, and install scripts determine what users receive.
          Reviewing the finished package lets you inspect those changes before publication. These
          incidents show why the published files deserve their own review.
        </p>
        <IncidentLog />
      </section>

      <section aria-label="Provenance and review" class="flex flex-col gap-4">
        <SectionLabel as="p">Provenance and review</SectionLabel>
        <h2 class="text-2xl font-semibold tracking-[-0.015em] m-0 max-w-[680px]">
          Check where the release came from and what it contains.
        </h2>
        <p class="m-0 text-[14px] text-ink-muted leading-[1.65] max-w-[680px]">
          Provenance can identify the repository and workflow that built a release. Drydock checks
          available provenance evidence alongside the package diff. A compromised build dependency
          can still produce an attested release, so reviewers need to inspect the contents too.
        </p>
        <LinkButton href="/npm-trusted-publishing" variant="ghost" size="sm" class="self-start">
          Pin publishing to a reviewed workflow →
        </LinkButton>
      </section>

      <section aria-label="How it works" class="flex flex-col gap-5">
        <SectionLabel as="h2">How it works</SectionLabel>
        <HowSteps
          items={[
            {
              title: "Choose where to review",
              body: (
                <>
                  Workflow Gate pauses a configured GitHub publish job while you review its uploaded
                  artifacts. Stage Watchtower reviews a private npm staged package; npm controls
                  approval and publication.
                </>
              ),
            },
            {
              title: "Inspect the package diff",
              body: (
                <>
                  Compare the candidate with its published baseline and inspect findings such as new
                  install scripts or credential reads. Findings point to the relevant files and
                  lines when available. Drydock reads package contents without executing them.
                </>
              ),
            },
            {
              title: "Record your decision",
              body: (
                <>
                  Approve or reject the protected GitHub job in Drydock. For npm staging, record
                  your review here and approve or reject separately in npm with 2FA. Publish
                  credentials stay in your release process.
                </>
              ),
            },
          ]}
        />
      </section>

      <section aria-label="Release integrations" class="flex flex-col gap-4">
        <SectionLabel as="h2">Release integrations</SectionLabel>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <RegistryCard title="Workflow Gate — enforced: npm, PyPI & VS Code">
            Configure a GitHub Environment to hold your publish job after CI builds and uploads the
            artifacts. Approval lets that job continue with its own credentials; rejection blocks
            it. Other publication paths remain outside this gate.
          </RegistryCard>
          <RegistryCard title="Stage Watchtower — advisory: npm">
            A maintainer runs <code class="font-mono text-[12px] text-ink">npm stage publish</code>{" "}
            to upload a private candidate. Drydock reviews the tarball and records your decision.
            You approve or reject independently in npm with 2FA, which also permits manual
            publication outside staging.
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
            Drydock uses scoped tokens to fetch release evidence. Publish credentials stay in npm or
            GitHub Actions.
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
          Add a review to your next release.
        </h2>
        <p class="m-0 text-[14px] text-ink-muted leading-[1.65] max-w-[620px]">
          Set up a GitHub workflow gate or connect npm staging to review your next candidate.
          Drydock never holds the credential that publishes it.
        </p>
        <div class="flex gap-3 mt-1">
          <Show
            when={authed}
            fallback={
              <>
                <LinkButton href="/register">Review my next release</LinkButton>
                <LinkButton href="/docs" variant="secondary">
                  Read the docs
                </LinkButton>
              </>
            }
          >
            <LinkButton href="/dashboard">Open reviews</LinkButton>
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

function RegistryCard({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <Card as="article" padding="compact" class="flex flex-col gap-2">
      <h2 class="text-base font-medium tracking-[-0.005em] m-0">{title}</h2>
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
