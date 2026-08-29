import { useLocation } from "preact-iso";
import { LinkButton } from "../../components/Button";
import { PageShell } from "../../components/PageShell";
import {
  ContentArticleEvidence,
  ContentArticleHero,
  ContentArticleLinks,
  ContentArticleSections,
  type ContentArticleSection,
} from "../../features/public-content/ContentArticle";
import { packageDiffPath } from "../../lib/package-diff-path";
import { incidentCaseSeoByPath, type IncidentCasePath, PageSeo } from "../../lib/seo";
import { MarketingHeaderActions } from "../MarketingHeaderActions";
import { useAuthedSession } from "../useAuthedSession";

interface IncidentCase {
  packageName: string;
  fromVersion: string;
  toVersion: string;
  heading: string;
  lead: string;
  /**
   * The one-line artifact signal this diff proves — rendered as the evidence
   * card's final row, so it stays a restatement of the compared releases rather
   * than a claim the page adds on top of them.
   */
  signal: string;
  sections: ContentArticleSection[];
  source: { href: string; label: string };
}

const INCIDENT_CASES: Record<IncidentCasePath, IncidentCase> = {
  "/incidents/node-ipc-peacenotwar": {
    packageName: "node-ipc",
    fromVersion: "9.2.1",
    toVersion: "11.0.0",
    heading: "node-ipc 11.0.0 added a new runtime dependency.",
    lead: "The published package metadata for node-ipc 11.0.0 adds peacenotwar, which is absent from 9.2.1. The surviving registry versions make the dependency change inspectable without installing either release.",
    signal: "dependency addition",
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
    heading: "es5-ext 0.10.54 added a postinstall hook in a patch release.",
    lead: "The published package metadata adds a postinstall command that runs _postinstall.js. Comparing 0.10.53 with 0.10.54 shows the new install-time behavior directly, without executing it.",
    signal: "postinstall added",
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

const INCIDENT_PATHS = Object.keys(INCIDENT_CASES) as IncidentCasePath[];

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
  const relatedLinks = [
    ...INCIDENT_PATHS.filter((incidentPath) => incidentPath !== path).map((incidentPath) => ({
      href: incidentPath,
      title: `${INCIDENT_CASES[incidentPath].packageName} ${INCIDENT_CASES[incidentPath].toVersion}`,
      description: incidentCaseSeoByPath[incidentPath].description,
    })),
    {
      href: "/diff",
      title: "Diff any package",
      description:
        "Compare two published npm, PyPI, or atpm releases file by file. No account, no installation.",
    },
  ];

  return (
    <PageShell
      width="doc"
      class="gap-12"
      headerActions={<MarketingHeaderActions authed={authed} />}
      feedbackPosition="end"
    >
      <PageSeo metadata={metadata} />
      <ContentArticleHero
        heading={incident.heading}
        lead={incident.lead}
        actions={
          <>
            <LinkButton href={diffPath}>Open the live artifact diff</LinkButton>
            <LinkButton href={incident.source.href} variant="secondary">
              {incident.source.label}
            </LinkButton>
          </>
        }
      />

      <ContentArticleEvidence
        label="What was compared"
        rows={[
          { label: "Ecosystem", value: "npm" },
          { label: "Package", value: incident.packageName },
          { label: "Compared", value: `${incident.fromVersion} → ${incident.toVersion}` },
          { label: "Artifact signal", value: incident.signal },
        ]}
      />

      <ContentArticleSections sections={incident.sections} />

      <ContentArticleLinks label="Keep reading diffs" links={relatedLinks} />
    </PageShell>
  );
}
