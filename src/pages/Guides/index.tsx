import { useLocation } from "preact-iso";
import { LinkButton } from "../../components/Button";
import { PageShell } from "../../components/PageShell";
import {
  ContentArticleCta,
  ContentArticleHero,
  ContentArticleLinks,
  ContentArticleSections,
  type ContentArticleSection,
} from "../../features/public-content/ContentArticle";
import { discoveryGuideSeoByPath, type DiscoveryGuidePath, PageSeo } from "../../lib/seo";
import { MarketingHeaderActions } from "../MarketingHeaderActions";
import { useAuthedSession } from "../useAuthedSession";

interface GuideContent {
  relatedTitle: string;
  heading: string;
  lead: string;
  details: string[];
  sections: ContentArticleSection[];
  primary: { href: string; label: string };
  secondary: { href: string; label: string };
  /**
   * The closing ask. Written per guide rather than shared: seven prerendered
   * pages repeating the landing's headline verbatim would read as template
   * filler and duplicate the landing as a search result.
   */
  close: {
    heading: string;
    body: string;
    action: { href: string; label: string };
    detail?: string[];
  };
}

const GUIDES: Record<DiscoveryGuidePath, GuideContent> = {
  "/npm-staged-publishing": {
    relatedTitle: "Stage Watchtower — advisory",
    heading: "Review an npm package before it becomes public.",
    lead: "Stage Watchtower reviews npm's private staged tarball before publication and records your decision. You approve or reject the stage through npm; account holders can still publish manually.",
    details: ["private candidate", "read-only npm access", "maintainer approves with 2FA"],
    sections: [
      {
        label: "The gap",
        heading: "Read what packaging changed.",
        body: "Build output, lifecycle scripts, bundled files, and generated code can differ from the source tree. Drydock compares the staged tarball with the published version so you can review those changes without running the package.",
      },
      {
        label: "The review",
        heading: "Check each finding against the package files.",
        body: "Deterministic checks flag install hooks, process execution, network access, credential reads, new binaries, and suspicious package structure. Findings link to the inspected evidence, with file and line context when available, so you can decide whether a change belongs in the release.",
      },
      {
        label: "The decision",
        heading: "Complete the stage through npm.",
        body: "Record your review decision in Drydock, then approve or discard the stage through npm with npm's own 2FA step. Drydock uses a read-only token to inspect the candidate and never receives a credential that can publish it.",
      },
      {
        label: "Narrow the CI path",
        heading: "Limit CI to staging.",
        body: "Configure npm's trusted publisher to allow staging only, and disallow tokens in the package settings. CI can then create a candidate but cannot publish it. Stage Watchtower remains advisory: npm allows interactive publication with password, 2FA, and an OTP, and stage approval does not require a Drydock review.",
      },
    ],
    close: {
      heading: "Review your next staged npm release.",
      body: "Connect a read-only npm token and run npm stage publish. Read the candidate diff, record your decision, then complete the stage through npm with 2FA.",
      action: { href: "/docs#staged-publishing", label: "Set up npm staging" },
      detail: ["read-only npm access", "you keep the final approval"],
    },
    primary: { href: "/docs#staged-publishing", label: "Set up npm staging" },
    secondary: { href: "/diff", label: "Diff a package" },
  },
  "/github-actions-package-gate": {
    relatedTitle: "Workflow Gate — enforced",
    heading: "Review built packages before the publish job runs.",
    lead: "Workflow Gate pauses the configured protected GitHub job after CI uploads the release artifacts. Review those files in Drydock, then accept or reject the job. Other publication paths remain outside the gate.",
    details: ["GitHub Environment", "exact uploaded artifacts", "npm, PyPI, and VS Code"],
    sections: [
      {
        label: "Build once",
        heading: "Review and publish the same bytes.",
        body: "The recommended workflow uploads the package plus a digest record. After approval, the publish job downloads that upload and verifies its digest before publishing. Keep the build in the first job so the published bytes match the reviewed upload.",
      },
      {
        label: "Hold",
        heading: "GitHub holds the protected job.",
        body: "Install Drydock as a custom deployment protection rule on a GitHub Environment. GitHub pauses the job while Drydock parses the uploaded archives without executing package code and prepares one report per package.",
      },
      {
        label: "Decide",
        heading: "One rejected package keeps the protected publish job blocked.",
        body: "A monorepo upload can contain several packages. The protected publish job continues only after you accept every package review. A rejection or incomplete artifact batch keeps that job blocked.",
      },
    ],
    close: {
      heading: "Add review to your publish workflow.",
      body: "Add the Drydock protection rule to your publish job's environment. CI builds and uploads the packages first; the protected job waits for your decision before publishing them.",
      action: { href: "/docs#workflow-gating", label: "Add a workflow gate" },
    },
    primary: { href: "/docs#workflow-gating", label: "Add a workflow gate" },
    secondary: { href: "/docs#gate-workflow", label: "See workflow examples" },
  },
  "/npm-trusted-publishing": {
    relatedTitle: "npm trusted publishing",
    heading: "Require review before your CI job gets npm publish credentials.",
    lead: "Pin npm trusted publishing to the GitHub Environment protected by Workflow Gate, then disallow token publication. The configured job receives its OIDC publish credential after you accept the review. npm still permits account holders to publish interactively with 2FA.",
    details: ["OIDC publish credentials", "protected environment", "token publishing disabled"],
    sections: [
      {
        label: "Pin the path",
        heading: "Tie npm credentials to the protected environment.",
        body: "A trusted publisher names the repository, workflow file, and GitHub Environment allowed to publish. npm rejects an OIDC exchange whose claims do not match, including a workflow that drops the environment. The protected job starts only after Drydock returns your acceptance to GitHub.",
      },
      {
        label: "Configure the workflow",
        heading: "Keep publishing on the reviewed path.",
        body: "Disallow token publication in npm's package settings and disable administrator bypass on the GitHub Environment. Use the recommended publish job to download the reviewed upload and verify its digest. GitHub then blocks the configured job when you reject, while the digest check in your publish job rejects changed bytes.",
      },
      {
        label: "Limits",
        heading: "Account holders retain other publication paths.",
        body: "npm permits interactive publication with 2FA, and an account owner can edit the trusted-publisher configuration. The gate governs the configured protected job. For each release, check the available provenance and review evidence to see which workflow and artifact it describes.",
      },
    ],
    close: {
      heading: "Configure npm's trusted publisher.",
      body: "Follow the repository guide to pin the publisher, protect the environment, and disallow tokens. It includes the workflow YAML and a table of the publication paths these settings control.",
      action: {
        href: "https://github.com/JoviDeCroock/drydock/blob/main/docs/npm-trusted-publishing.md",
        label: "Read the full recipe",
      },
      detail: ["configuration only", "protected job fails closed"],
    },
    primary: { href: "/docs#workflow-gating", label: "Add a workflow gate" },
    secondary: { href: "/github-actions-package-gate", label: "How the gate works" },
  },
  "/pypi-release-security": {
    relatedTitle: "PyPI release security",
    heading: "Review wheels and source distributions before uploading to PyPI.",
    lead: "CI uploads your built wheels and source distributions, then Workflow Gate pauses the configured protected publish job for your review. PyPI has no private staged release; the job waits in GitHub before uploading to the registry.",
    details: ["wheel and sdist review", "GitHub workflow gate", "trusted publishing stays in CI"],
    sections: [
      {
        label: "Artifact evidence",
        heading: "Review generated code and package metadata.",
        body: "Wheel metadata, RECORD entries, native extensions, generated modules, setup code, and source-distribution contents all affect what installers receive. Drydock compares each uploaded artifact with the published baseline without importing or building it.",
      },
      {
        label: "Integrity",
        heading: "Metadata and archive contents must agree.",
        body: "The review checks package identity, version metadata, wheel records, build and install entry points, dependency changes, credential access, process execution, network capability, and unexplained binary payloads.",
      },
      {
        label: "Credential boundary",
        heading: "PyPI credentials remain in the publish workflow.",
        body: "Drydock reviews the uploaded packages and returns your decision to GitHub. The protected publish job uses its own trusted-publishing identity and uploads only after you accept the review.",
      },
    ],
    close: {
      heading: "Review your next Python release.",
      body: "Upload the built distributions from CI and protect the publish job with a workflow gate. After you accept the review, that job verifies and uploads the reviewed files through trusted publishing.",
      action: { href: "/docs#workflow-gating", label: "Protect a PyPI workflow" },
    },
    primary: { href: "/docs#workflow-gating", label: "Protect a PyPI workflow" },
    secondary: { href: "/diff", label: "Diff a PyPI project" },
  },
  "/vscode-extension-security": {
    relatedTitle: "VS Code extension security",
    heading: "Review your packaged VS Code extension before publishing.",
    lead: "A VS Code extension can access the editor and developer workstation. Workflow Gate pauses the configured protected marketplace publish job so you can review the packaged VSIX before that job runs.",
    details: ["VSIX artifact review", "activation and entrypoint checks", "human release gate"],
    sections: [
      {
        label: "Package contents",
        heading: "Check what the VSIX includes.",
        body: "Bundled JavaScript, extension manifests, browser and Node entry points, activation events, contributed commands, native files, and files excluded from source review can all change during packaging.",
      },
      {
        label: "Signals",
        heading: "Review the capabilities introduced by the release.",
        body: "Drydock flags entrypoint and activation changes, process and network access, credential and home-directory reads, dependency changes, obfuscation, binaries, and manifest inconsistencies. Review those findings without loading the extension.",
      },
      {
        label: "Publication",
        heading: "Keep the marketplace token in GitHub Actions.",
        body: "GitHub holds the protected publish job and its credential. If you accept the VSIX review, that job verifies and publishes the reviewed upload. Rejection blocks the configured job; other publication paths remain outside the gate.",
      },
    ],
    close: {
      heading: "Review your next extension release.",
      body: "Protect the marketplace publish job with a review of the packaged VSIX. Your workflow keeps the marketplace token and publishes the reviewed upload after you accept it.",
      action: { href: "/docs#workflow-gating", label: "Protect a VS Code release" },
    },
    primary: { href: "/docs#workflow-gating", label: "Protect a VS Code release" },
    secondary: { href: "/docs#gate-workflow", label: "Read the VS Code example" },
  },
  "/package-tarball-diff": {
    relatedTitle: "Public package diff",
    heading: "Read what changed between two package releases.",
    lead: "Compare published npm, PyPI, or atpm releases file by file. Drydock runs deterministic checks on the package archives and links findings to the inspected evidence. You can read the diff without an account or installing the package.",
    details: ["no account", "no installation", "npm, PyPI, and atpm"],
    sections: [
      {
        label: "Source versus artifact",
        heading: "Compare generated and bundled files.",
        body: "Package archives include generated bundles, vendored dependencies, lifecycle hooks, metadata, and files selected by packaging rules. Comparing published archives helps you review changes that a source pull request may not show.",
      },
      {
        label: "Deterministic review",
        heading: "Review the findings alongside the diff.",
        body: "The public diff runs deterministic checks rather than AI review. Each finding names its rule and the inspected evidence so you can assess it alongside the changed files. Drydock never executes the package code.",
      },
      {
        label: "Before publish",
        heading: "Compare a preview build before publication.",
        body: "Paste a pkg.pr.new URL to compare a pull-request preview with the latest public release. Maintainers can then use npm staging or a GitHub workflow gate to apply the same review to the final candidate.",
      },
    ],
    close: {
      heading: "Compare two published releases.",
      body: "Pick a package and two versions to read the file changes and findings. No account required.",
      action: { href: "/diff", label: "Diff a package" },
    },
    primary: { href: "/diff", label: "Diff a package" },
    secondary: { href: "/docs#dependency-updates", label: "Add diffs to dependency PRs" },
  },
  "/security": {
    relatedTitle: "Drydock security model",
    heading: "Inspect package code without running it.",
    lead: "Drydock parses package archives in a sandbox with limits on what it can inspect. Publish credentials stay outside that sandbox. You review the evidence and keep the final decision.",
    details: ["package code never executes", "publish credentials stay outside", "human decision"],
    sections: [
      {
        label: "Artifact isolation",
        heading: "Read archives without running package code.",
        body: "Drydock never runs lifecycle scripts, imports package modules, invokes package builds, renders package-provided active content, or shells out to package tooling. Traversal paths and non-regular entries are rejected; malformed archives fail the scan. Inspection caps produce explicit content-skipped findings or hash-only evidence so reviewers can see where full inspection stopped.",
      },
      {
        label: "Credentials",
        heading: "Publish credentials stay with your release process.",
        body: "npm staging uses a read-only token through a constrained gateway. Workflow-gated releases keep registry credentials inside GitHub Actions. Token material is never passed into the package sandbox or written into review evidence.",
      },
      {
        label: "Evidence and decisions",
        heading: "Deterministic findings remain authoritative.",
        body: "AI review is advisory and cannot downgrade rule findings. Reports retain redacted evidence rather than raw archives by default. You decide whether to release; Drydock never publishes or collects an approval code.",
      },
    ],
    close: {
      heading: "Inspect the security model.",
      body: "The repository includes the sandbox implementation, credential gateways, and tests for rejected inputs. Read a public package diff to see the report this inspection produces.",
      action: { href: "/diff", label: "Diff a package" },
    },
    primary: { href: "/docs#safety-model", label: "Read the safety guide" },
    secondary: {
      href: "https://github.com/JoviDeCroock/drydock/blob/main/docs/security-model.md",
      label: "Open the engineering model",
    },
  },
  "/open-source": {
    relatedTitle: "Open-source package review",
    heading: "Inspect the detection rules or host your own Drydock.",
    lead: "Drydock's Apache-2.0 source includes its detection rules, sandbox, report model, and deployment configuration. Use the hosted service or deploy the review system in your own Cloudflare account.",
    details: ["Apache-2.0", "public detection rules", "Cloudflare self-hosting"],
    sections: [
      {
        label: "Detection rules",
        heading: "Trace each finding to its rule.",
        body: "Deterministic rule IDs, severities, evidence text, risk computation, regression fixtures, and detection-eval coverage live in the repository. Public package diffs run those deterministic checks without an AI reviewer.",
      },
      {
        label: "Security model",
        heading: "Audit the sandbox and credential handling.",
        body: "Read the archive parsers, network gateways, credential separation, redaction, and ownership checks in the repository. The accompanying tests show how Drydock handles invalid archives and unauthorized access.",
      },
      {
        label: "Self-hosting",
        heading: "Operate Drydock in your own Cloudflare account.",
        body: "The repository documents the Worker, D1, Dynamic Worker loader, optional queues and caches, GitHub App, npm connection, and deployment configuration needed to run an independent installation.",
      },
    ],
    close: {
      heading: "Read the code behind the report.",
      body: "Start with the detection rules and their test fixtures. The repository also includes setup instructions if you want to run Drydock in your own Cloudflare account.",
      action: { href: "https://github.com/JoviDeCroock/drydock", label: "View the source" },
    },
    primary: {
      href: "https://github.com/JoviDeCroock/drydock",
      label: "View the source",
    },
    secondary: {
      href: "https://github.com/JoviDeCroock/drydock/blob/main/docs/self-hosting.md",
      label: "Read self-hosting setup",
    },
  },
  "/maintainer-pledge": {
    relatedTitle: "The maintainer pledge",
    heading: "Review your own public package releases for free.",
    lead: "Drydock is free for open-source maintainers reviewing packages they publish to a public registry. We plan to keep it that way. This pledge covers release review; it does not guarantee hosted availability or free access to every future feature.",
    details: ["free for public packages", "Apache-2.0 source", "sponsor-funded"],
    sections: [
      {
        label: "What it covers",
        heading: "Public packages, for the maintainer who publishes them.",
        body: "The pledge covers reviewing your staged tarball or gated workflow artifact, reading the report, and recording your decision. Public package comparisons at /diff are also available without an account.",
      },
      {
        label: "Limits",
        heading: "The pledge covers public package review.",
        body: "Drydock has no paid plans today. We expect future paid offerings to cover private packages and company release processes. This pledge does not promise permanent hosting, an uptime guarantee, or free access to every future capability. Aikido Security currently sponsors development and does not influence detection rules, findings, or risk scoring.",
      },
      {
        label: "Self-hosting",
        heading: "The source gives you another way to keep using Drydock.",
        body: "The detection rules, sandbox, report model, and deployment configuration are public under Apache-2.0. You can deploy the same review system in your own Cloudflare account if the hosted service changes or closes.",
      },
    ],
    close: {
      heading: "Start by reading a diff.",
      body: "Compare two versions of a package you publish. Review the changed files and findings to decide whether Drydock belongs in your release process.",
      action: { href: "/diff", label: "Diff a package" },
    },
    primary: { href: "/diff", label: "Diff a package" },
    secondary: {
      href: "https://github.com/JoviDeCroock/drydock/blob/main/docs/self-hosting.md",
      label: "Read self-hosting setup",
    },
  },
};

const GUIDE_PATHS = Object.keys(GUIDES) as DiscoveryGuidePath[];

export default function DiscoveryGuidePage() {
  const authed = useAuthedSession();
  const path = useLocation().path.replace(/\/$/, "") as DiscoveryGuidePath;
  const guide = GUIDES[path] ?? GUIDES["/package-tarball-diff"];
  const metadata =
    discoveryGuideSeoByPath[path] ?? discoveryGuideSeoByPath["/package-tarball-diff"];
  const relatedGuides = GUIDE_PATHS.filter((guidePath) => guidePath !== path).map((guidePath) => ({
    href: guidePath,
    title: GUIDES[guidePath].relatedTitle,
    description: discoveryGuideSeoByPath[guidePath].description,
  }));

  return (
    <PageShell
      width="doc"
      class="gap-12"
      headerActions={<MarketingHeaderActions authed={authed} />}
    >
      <PageSeo metadata={metadata} />
      <ContentArticleHero
        heading={guide.heading}
        lead={guide.lead}
        details={guide.details}
        actions={
          <>
            <LinkButton href={guide.primary.href}>{guide.primary.label}</LinkButton>
            <LinkButton href={guide.secondary.href} variant="secondary">
              {guide.secondary.label}
            </LinkButton>
          </>
        }
      />

      <ContentArticleSections sections={guide.sections} />

      {/* One button, not the hero's pair: repeating both a screen later reads
          as a template, and a single decisive ask closes better. The close
          names its own action so it can point somewhere the hero did not. */}
      <ContentArticleCta
        label="Get started"
        heading={guide.close.heading}
        body={guide.close.body}
        actions={<LinkButton href={guide.close.action.href}>{guide.close.action.label}</LinkButton>}
        detail={guide.close.detail}
      />

      <ContentArticleLinks label="Explore Drydock" links={relatedGuides} />
    </PageShell>
  );
}
