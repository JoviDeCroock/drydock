import { LinkButton } from "../../components/Button";
import { PageShell } from "../../components/PageShell";
import {
  ContentArticleCta,
  ContentArticleEvidence,
  ContentArticleHero,
  ContentArticleLinks,
  ContentArticleSections,
  type ContentArticleSection,
} from "../../features/public-content/ContentArticle";
import { PageSeo, trustedPublishingReplaySeo } from "../../lib/seo";
import { MarketingHeaderActions } from "../MarketingHeaderActions";
import { useAuthedSession } from "../useAuthedSession";

const SOCKET_BEE_JS = "https://socket.dev/blog/bee-js-compromise";
const STEPSECURITY_WPPCONNECT =
  "https://www.stepsecurity.io/blog/wppconnect-compromised-malicious-releases-steal-secrets-and-whatsapp-sessions";

// Both malicious versions are gone from npm, so there is no live diff to link.
// Every fact below is from the two cited write-ups; rule behavior is pinned by
// test/fixtures/security-corpus/cases/incident-{bee-js,wppconnect}-*.json and
// test/workflow-gate-release-source.test.ts.
const SECTIONS: ContentArticleSection[] = [
  {
    label: "bee-js 13.3.0, 9 November",
    heading: "A commit on no branch, tagged and released by the project's own workflow.",
    body: "An unsigned commit that never went through a pull request was tagged v13.3.0. The release event started the Publish on npm workflow, which published with trusted publishing and valid SLSA provenance. The package.json diff renamed the existing prepare script to postinstall and added scripts to the files list, so the tarball now shipped and ran scripts/generate-version.cjs on install. That script fetched code from a remote host and ran it with new Function. The publish Environment had no required reviewers and no tag policy. npm removed the version about 75 minutes later.",
  },
  {
    label: "WPPConnect 2.4.1, 15 November",
    heading: "A direct push to master, then the tag was moved after publish.",
    body: "Two unsigned commits were pushed straight to master with no pull request. A manual release dispatch created the v2.4.1 tag, and the tag push ran publish.yml, which has no environment key, so nothing stood between the tag and the registry. The release added a module imported by the browser controller. On import it read environment variables, .env and config files, and WhatsApp session files, then sent them to a Telegram bot. There was no install hook: --ignore-scripts would not have helped. The provenance named the malicious commit accurately. Hours later the tag was force-moved to a clean-looking commit, then deleted.",
  },
  {
    label: "Why provenance did not help",
    heading: "Provenance records where a package was built, not who reviewed it.",
    body: "Both attestations were valid. They named the right repository, workflow and commit. bee-js 13.2.0's attestation has exactly the same shape as 13.3.0's. Provenance answers which pipeline produced the bytes. When an attacker can push a commit or a tag, the project's real pipeline produces the release for them, and the attestation vouches for it.",
  },
  {
    label: "Where a Drydock gate holds the release",
    heading: "GitHub holds the publish job until a person approves the bytes in Drydock.",
    body: "With Drydock as the publish Environment's deployment-protection rule, GitHub holds the publish job and Drydock reviews the uploaded tarball against the last release before anyone decides. The real tarballs are gone from npm, so we rebuilt each release's change as a synthetic fixture from the published write-ups and ran Drydock's rules on it. For bee-js the rules report install-script.lifecycle (high) for the new postinstall hook, package-json.files-widened (medium) for the files change that ships the hook's script, and network-access and dynamic-evaluation findings (high) on the script that downloads and evaluates a remote payload. For WPPConnect they report credential-access and network-access findings (high) on the new import-time module that reads environment variables and files and sends them out. Both reconstructions reach high release risk, so the workbench would recommend rejection. A person still makes the decision.",
  },
  {
    label: "New: where the release commit came from",
    heading: "The gate now checks the commit and the tag the run built.",
    body: "Before the review, Drydock asks GitHub whether the run's commit is on a protected branch. bee-js's commit was on no branch, so its review would carry release.unprotected-commit (medium). For a run started from a tag, Drydock also checks that the tag still names the built commit: release.tag-mismatch (high) if it was moved, or if a release's tag was deleted. Approval re-checks the tag, so a tag moved between review and approval makes the review stale and refuses the approval. WPPConnect's tag was moved hours after publish; on a gated release that is after the decision, and only reading the provenance's commit, not the tag, shows what shipped.",
  },
  {
    label: "Limits",
    heading: "What these checks do not cover.",
    body: "The gate covers only jobs that target the configured Environment. Pin npm trusted publishing to that Environment so no other job can get the publish credential. A medium unprotected-commit finding alone does not change the recommendation, because a maintenance release from an unprotected branch has the same shape. These checks need the GitHub App's Contents read permission; without it they stay quiet. A repository admin can remove the protection rule. None of this tells you a release is safe. It shows a reviewer what changed and where it came from.",
  },
];

export default function TrustedPublishingReplayPage() {
  const authed = useAuthedSession();
  return (
    <PageShell
      width="doc"
      class="gap-12"
      headerActions={<MarketingHeaderActions authed={authed} />}
    >
      <PageSeo metadata={trustedPublishingReplaySeo} />
      <ContentArticleHero
        heading="Two trusted-publishing releases with valid provenance turned out to be malware."
        lead="bee-js 13.3.0 and WPPConnect 2.4.1 were both built and published by the projects' own GitHub workflows, with valid npm provenance. Provenance shows where a package was built. It does not show that anyone reviewed what was built. This page walks both releases through a Drydock workflow gate."
        actions={
          <>
            <LinkButton href="/github-actions-package-gate">Add a workflow gate</LinkButton>
            <LinkButton href="/diff" variant="secondary">
              Read a diff
            </LinkButton>
          </>
        }
      />

      <ContentArticleEvidence
        label="bee-js 13.3.0"
        rows={[
          { label: "New install hook", value: "prepare renamed to postinstall" },
          { label: "files change", value: "scripts added, shipping the hook's script" },
          { label: "Reviewers on publish", value: "none: Environment had no required reviewers" },
          { label: "Commit", value: "on no branch, no pull request" },
          { label: "Tag", value: "named the malicious commit" },
        ]}
      />

      <ContentArticleEvidence
        label="WPPConnect 2.4.1"
        rows={[
          { label: "New install hook", value: "none: runs on import" },
          { label: "files change", value: "not reported" },
          { label: "Reviewers on publish", value: "none: publish job had no Environment" },
          { label: "Commit", value: "pushed directly to master, no pull request" },
          { label: "Tag", value: "moved to a clean-looking commit after publish, then deleted" },
        ]}
      />

      <ContentArticleSections sections={SECTIONS} />

      <ContentArticleCta
        label="Put a person between the tag and the registry"
        heading="Gate the publish job, not just the build."
        body="A workflow gate makes GitHub hold the configured publish job until someone approves the exact uploaded bytes in Drydock. Pair it with npm trusted publishing pinned to the gated Environment."
        actions={
          <>
            <LinkButton href="/github-actions-package-gate">Add a workflow gate</LinkButton>
            <LinkButton href="/npm-trusted-publishing" variant="secondary">
              Pin trusted publishing
            </LinkButton>
          </>
        }
      />

      <ContentArticleLinks
        label="Sources and related reading"
        links={[
          {
            href: SOCKET_BEE_JS,
            title: "Socket: bee-js compromise",
            description: "Timeline, payload stages and provenance verification for bee-js 13.3.0.",
          },
          {
            href: STEPSECURITY_WPPCONNECT,
            title: "StepSecurity: WPPConnect compromised",
            description: "Commits, workflow runs, payload and tag history for WPPConnect 2.4.1.",
          },
          {
            href: "/incidents/es5-ext-postinstall",
            title: "es5-ext 0.10.54",
            description: "A postinstall hook added in a patch release, in a live artifact diff.",
          },
        ]}
      />
    </PageShell>
  );
}
