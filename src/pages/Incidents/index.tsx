import { useLocation } from "preact-iso";
import { LinkButton } from "../../components/Button";
import { PageShell } from "../../components/PageShell";
import { Eyebrow, MonoDetail, SectionLabel } from "../../components/Typography";
import { packageDiffPath } from "../../lib/package-diff-path";
import { incidentCaseSeoByPath, type IncidentCasePath, PageSeo } from "../../lib/seo";
import { MarketingHeaderActions } from "../MarketingHeaderActions";
import { useAuthedSession } from "../useAuthedSession";

interface IncidentCase {
  packageName: string;
  fromVersion: string;
  toVersion: string;
  eyebrow: string;
  heading: string;
  lead: string;
  details: string[];
  sections: Array<{ label: string; heading: string; body: string }>;
  source: { href: string; label: string };
}

const INCIDENT_CASES: Record<IncidentCasePath, IncidentCase> = {
  "/incidents/node-ipc-peacenotwar": {
    packageName: "node-ipc",
    fromVersion: "9.2.1",
    toVersion: "11.0.0",
    eyebrow: "Historical npm artifact diff",
    heading: "node-ipc 11.0.0 added a new runtime dependency.",
    lead: "The published package metadata for node-ipc 11.0.0 adds peacenotwar, which is absent from 9.2.1. The surviving registry versions make the dependency change inspectable without installing either release.",
    details: ["node-ipc", "9.2.1 → 11.0.0", "dependency addition"],
    sections: [
      {
        label: "What changed",
        heading: "The release pulls code from a package the parent diff cannot inspect.",
        body: "Drydock flags the new runtime dependency; the selected version pair also makes the parent package's major jump visible. That is a review boundary, not a verdict: a maintainer should inspect the dependency's own published artifact and decide whether the expanded install-time trust is expected.",
      },
      {
        label: "Why it matters",
        heading: "A clean-looking parent archive can still expand its execution graph.",
        body: "Source review of the parent repository is not enough when a release changes the packages installed beside it. Artifact review makes the new dependency visible before the release reaches consumers.",
      },
      {
        label: "Scope note",
        heading: "Do not conflate this diff with the separate 10.1.x advisory.",
        body: "GitHub's reviewed advisory covers destructive code in node-ipc 10.1.1 and 10.1.2. Those versions are a different release line from the surviving 9.2.1-to-11.0.0 diff shown here. This page claims only what the inspected artifacts prove: 11.0.0 added peacenotwar as a dependency.",
      },
    ],
    source: {
      href: "https://github.com/advisories/GHSA-97m3-w2cp-4xx6",
      label: "Read the separate 10.1.x advisory",
    },
  },
  "/incidents/es5-ext-postinstall": {
    packageName: "es5-ext",
    fromVersion: "0.10.53",
    toVersion: "0.10.54",
    eyebrow: "Historical npm artifact diff",
    heading: "es5-ext 0.10.54 added a postinstall hook in a patch release.",
    lead: "The published package metadata adds a postinstall command that runs _postinstall.js. Comparing 0.10.53 with 0.10.54 shows the new install-time behavior directly, without executing it.",
    details: ["es5-ext", "0.10.53 → 0.10.54", "postinstall added"],
    sections: [
      {
        label: "What changed",
        heading: "Installation gained an executable step.",
        body: "Drydock flags the new postinstall script and pins the finding to package.json. The file diff then exposes the script that the package manager would run, giving a reviewer evidence before choosing whether to accept the release.",
      },
      {
        label: "Maintainer context",
        heading: "The behavior was described as a conditional message.",
        body: "In the package's public issue, the maintainer says the script conditionally displays a message for Russian time zones and does not affect the package's core functionality. The artifact diff verifies the added hook and code; it does not infer intent or label the package a virus.",
      },
      {
        label: "Why it matters",
        heading: "Patch releases can change install-time capabilities.",
        body: "A small semantic-version increment does not make a lifecycle hook routine. Package review should treat new execution paths as an explicit decision, independent of whether the script is destructive, benign, or outside the library's advertised purpose.",
      },
    ],
    source: {
      href: "https://github.com/medikoo/es5-ext/issues/186",
      label: "Read the maintainer discussion",
    },
  },
};

export default function IncidentCasePage() {
  const authed = useAuthedSession();
  const path = useLocation().path.replace(/\/$/, "") as IncidentCasePath;
  const incident = INCIDENT_CASES[path] ?? INCIDENT_CASES["/incidents/node-ipc-peacenotwar"];
  const metadata =
    incidentCaseSeoByPath[path] ?? incidentCaseSeoByPath["/incidents/node-ipc-peacenotwar"];
  const diffPath = packageDiffPath(
    "npm",
    incident.packageName,
    incident.fromVersion,
    incident.toVersion,
  );

  return (
    <PageShell
      width="doc"
      class="gap-12"
      headerActions={<MarketingHeaderActions authed={authed} />}
      feedbackPosition="end"
    >
      <PageSeo metadata={metadata} />
      <header class="py-8 md:py-12 border-t border-border flex flex-col gap-5">
        <Eyebrow tone="accent">{incident.eyebrow}</Eyebrow>
        <h1 class="text-4xl md:text-5xl font-semibold tracking-[-0.03em] leading-[1.05] max-w-[760px] m-0">
          {incident.heading}
        </h1>
        <p class="text-[17px] text-ink-muted max-w-[660px] leading-[1.6] m-0">{incident.lead}</p>
        <MonoDetail parts={incident.details} />
        <div class="flex flex-wrap gap-3 mt-1">
          <LinkButton href={diffPath}>Open the live artifact diff</LinkButton>
          <LinkButton href={incident.source.href} variant="secondary">
            {incident.source.label}
          </LinkButton>
        </div>
      </header>

      <div class="flex flex-col gap-10">
        {incident.sections.map((section) => (
          <section key={section.label} class="flex flex-col gap-3">
            <SectionLabel as="p">{section.label}</SectionLabel>
            <h2 class="text-2xl font-semibold tracking-[-0.015em] m-0 max-w-[680px]">
              {section.heading}
            </h2>
            <p class="m-0 max-w-[680px] text-[14px] text-ink-muted leading-[1.65]">
              {section.body}
            </p>
          </section>
        ))}
      </div>
    </PageShell>
  );
}
