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
    lead: "npm can hold a private staged tarball before publication. Stage Watchtower reviews and records that exact candidate, while the maintainer independently approves or rejects it in npm and can still publish manually.",
    details: ["private candidate", "read-only npm access", "maintainer approves with 2FA"],
    sections: [
      {
        label: "The gap",
        heading: "A staged version number is not an artifact review.",
        body: "Build output, lifecycle scripts, bundled files, and generated code can differ from the source tree. Drydock opens the staged tarball without executing it and shows the package-level delta a maintainer is actually being asked to publish.",
      },
      {
        label: "The review",
        heading: "Risk signals stay tied to inspected evidence.",
        body: "Deterministic checks flag install hooks, process execution, network access, credential reads, new binaries, suspicious package shape, and other supply-chain changes. Each finding points back to the relevant artifact evidence, with file and line context when available.",
      },
      {
        label: "The decision",
        heading: "Drydock never receives the publish approval.",
        body: "The maintainer records a review decision, then completes or discards the stage through npm with npm's own 2FA step. Drydock needs read-only evidence access, not a token that can publish packages.",
      },
      {
        label: "Narrow the CI path",
        heading: "A trusted publisher can stage without being able to publish.",
        body: "npm can grant a CI identity permission to stage and withhold permission to publish; disallowing tokens also closes token-based publication. Stage Watchtower remains advisory, however: an account holder can still publish interactively with password, 2FA, and an OTP, and npm does not require a Drydock decision before approving a stage.",
      },
    ],
    close: {
      heading: "Stage your next npm publish.",
      body: "Connect a read-only npm token, run your usual publish with a stage flag, and read the candidate tarball before you finish it. The 2FA step stays with npm.",
      action: { href: "/docs#staged-publishing", label: "Set up npm staging" },
      detail: ["read-only npm access", "you keep the final approval"],
    },
    primary: { href: "/docs#staged-publishing", label: "Set up npm staging" },
    secondary: { href: "/diff", label: "Read a public diff" },
  },
  "/github-actions-package-gate": {
    relatedTitle: "Workflow Gate — enforced",
    heading: "Pause package publication until the built artifacts are reviewed.",
    lead: "A GitHub Environment can hold a publish job after CI builds and uploads the release artifacts. Drydock reviews those exact files, then returns a human accept or reject decision to the waiting workflow.",
    details: ["GitHub Environment", "exact uploaded artifacts", "npm, PyPI, and VS Code"],
    sections: [
      {
        label: "Build once",
        heading: "Review and publish the same bytes.",
        body: "The build job uploads the package plus a digest record. After approval, the publish job downloads that upload and verifies the digest instead of rebuilding. That closes the gap between the artifact a maintainer read and the artifact the registry receives.",
      },
      {
        label: "Hold",
        heading: "The release waits in GitHub, not in Drydock.",
        body: "Drydock is installed as a custom deployment protection rule. GitHub keeps the protected job paused while Drydock parses the uploaded archives in a non-executing sandbox and prepares one report per package.",
      },
      {
        label: "Decide",
        heading: "One rejected package keeps the protected publish job blocked.",
        body: "A monorepo upload can contain several packages. The workflow continues only after every package review is accepted; a rejection or malformed artifact prevents the protected publish job from proceeding.",
      },
    ],
    close: {
      heading: "Put a review between build and publish.",
      body: "Add the Drydock protection rule to the environment your publish job already uses. The build keeps running; the upload just waits for a human before it reaches a registry.",
      action: { href: "/docs#workflow-gating", label: "Add a workflow gate" },
    },
    primary: { href: "/docs#workflow-gating", label: "Add a workflow gate" },
    secondary: { href: "/docs#gate-workflow", label: "See workflow examples" },
  },
  "/npm-trusted-publishing": {
    relatedTitle: "npm trusted publishing",
    heading: "Enforce review on the configured npm workflow.",
    lead: "Workflow Gate can approve or reject the configured protected GitHub job. Pinning npm trusted publishing to that environment and disallowing tokens means the workflow's OIDC credential only exists after review; npm's separate interactive 2FA publish path remains possible.",
    details: ["OIDC, no npm tokens", "environment pinned to the gate", "configuration, not code"],
    sections: [
      {
        label: "Pin the path",
        heading: "npm issues credentials only inside the gated environment.",
        body: "A trusted publisher names one repository, one workflow file, and one GitHub Environment. With the environment pinned, the OIDC exchange fails for any other job — including an edited workflow that drops the environment — and the pinned job cannot start until the environment's protection rule, the Drydock review, has passed.",
      },
      {
        label: "Close the side doors",
        heading: "Every configured-workflow bypass runs into a specific pin.",
        body: "Package settings disallow token-backed laptop publishes and CI secrets. Another repository or a fork fails the trusted-publisher claim match. The configured protected job cannot publish past a rejection. Rebuilding after approval fails the digest re-check, and administrator bypass is switched off on the environment itself. Interactive account publication with 2FA remains possible.",
      },
      {
        label: "The honest residue",
        heading: "What only the registry can close.",
        body: "The npm account owner can still publish interactively with 2FA, and whoever controls the account can edit the trusted-publisher configuration. npm has no publisher-only mode today. A release that ships around the pinned path is still visible — it carries no provenance attestation and no review — so bypass becomes detectable even where it is not preventable.",
      },
    ],
    close: {
      heading: "Pin your publish path.",
      body: "The whole recipe is configuration: one trusted-publisher entry, one environment setting, one token policy. The step-by-step with the workflow YAML and the full bypass table is in the open repository.",
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
    lead: "PyPI does not hold a private staged release, so Drydock protects the publish job instead. CI uploads the wheels and source distributions for review before trusted publishing sends them to the registry.",
    details: ["wheel and sdist review", "GitHub workflow gate", "trusted publishing stays in CI"],
    sections: [
      {
        label: "Artifact evidence",
        heading: "Python packages ship more than repository source.",
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
        body: "Drydock reviews the uploaded evidence and returns a gate decision. The workflow keeps its own trusted-publishing identity and uploads only after the human review succeeds.",
      },
    ],
    close: {
      heading: "Review the wheels before PyPI does.",
      body: "Upload the built distributions from CI, gate the publish job on the review, and keep trusted publishing exactly where it is.",
      action: { href: "/docs#workflow-gating", label: "Protect a PyPI workflow" },
    },
    primary: { href: "/docs#workflow-gating", label: "Protect a PyPI workflow" },
    secondary: { href: "/diff", label: "Diff a PyPI project" },
  },
  "/vscode-extension-security": {
    relatedTitle: "VS Code extension security",
    heading: "Inspect the VSIX that users will install before publication.",
    lead: "A VS Code extension can execute with broad access to the editor and developer workstation. Drydock reviews the packaged VSIX behind a GitHub Environment before the marketplace publish step runs.",
    details: ["VSIX artifact review", "activation and entrypoint checks", "human release gate"],
    sections: [
      {
        label: "Package shape",
        heading: "The marketplace receives the VSIX, not the branch.",
        body: "Bundled JavaScript, extension manifests, browser and Node entry points, activation events, contributed commands, native files, and files excluded from source review can all change during packaging.",
      },
      {
        label: "Signals",
        heading: "Review the capabilities introduced by the release.",
        body: "Drydock highlights entrypoint and activation changes, process and network access, credential and home-directory reads, dependency deltas, obfuscation, binaries, and manifest inconsistencies without loading the extension.",
      },
      {
        label: "Publication",
        heading: "The marketplace token never enters Drydock.",
        body: "GitHub holds the publish job and its credential. If the VSIX review is accepted, the workflow verifies and publishes the same uploaded artifact; rejection keeps the release out of the marketplace.",
      },
    ],
    close: {
      heading: "Read the VSIX your users will install.",
      body: "Gate the marketplace publish job on a review of the packaged extension. The marketplace token never leaves your workflow.",
      action: { href: "/docs#workflow-gating", label: "Protect a VS Code release" },
    },
    primary: { href: "/docs#workflow-gating", label: "Protect a VS Code release" },
    secondary: { href: "/docs#gate-workflow", label: "Read the VS Code example" },
  },
  "/package-tarball-diff": {
    relatedTitle: "Public package diff",
    heading: "Compare the package bytes that registries actually serve.",
    lead: "Drydock can diff two public npm, PyPI, or atpm releases file by file, with deterministic supply-chain findings tied to the relevant artifact evidence. It requires no account and never installs the package.",
    details: ["no account", "no installation", "npm, PyPI, and atpm"],
    sections: [
      {
        label: "Source versus artifact",
        heading: "A repository diff cannot prove what was published.",
        body: "Package archives include generated bundles, vendored dependencies, lifecycle hooks, metadata, and files selected by packaging rules. Comparing registry artifacts exposes changes that never appeared in a pull request.",
      },
      {
        label: "Deterministic review",
        heading: "Every signal comes from a named, inspectable check.",
        body: "The anonymous surface runs deterministic checks only. Package code is treated as hostile evidence, never executed, and every signal remains inspectable in the underlying file diff.",
      },
      {
        label: "Before publish",
        heading: "Preview builds can use the same review boundary.",
        body: "Paste a pkg.pr.new URL to compare a pull-request preview with the latest public release. Maintainers can then use npm staging or a GitHub workflow gate to apply the same review to the final candidate.",
      },
    ],
    close: {
      heading: "Diff a package right now.",
      body: "No account, no installation, no token. Pick two published versions and read what actually changed between the artifacts.",
      action: { href: "/diff", label: "Diff a package" },
    },
    primary: { href: "/diff", label: "Diff a package" },
    secondary: { href: "/docs#dependency-updates", label: "Add diffs to dependency PRs" },
  },
  "/security": {
    relatedTitle: "Drydock security model",
    heading: "Package artifacts are hostile evidence, never executable input.",
    lead: "Drydock is built around a narrow trust boundary: it reads bounded package evidence in a non-executing sandbox, keeps publish credentials elsewhere, and leaves every release decision with a human maintainer.",
    details: ["package code never executes", "publish credentials stay outside", "human decision"],
    sections: [
      {
        label: "Artifact isolation",
        heading: "Archives are parsed, not installed.",
        body: "Drydock never runs lifecycle scripts, imports package modules, invokes package builds, renders package-provided active content, or shells out to package tooling. Traversal paths and non-regular entries are rejected; malformed archives fail the scan. Inspection caps produce explicit content-skipped findings or hash-only evidence so reviewers can see where full inspection stopped.",
      },
      {
        label: "Credentials",
        heading: "Review access cannot become publish access.",
        body: "npm staging uses a read-only token through a constrained gateway. Workflow-gated releases keep registry credentials inside GitHub Actions. Token material is never passed into the package sandbox or written into review evidence.",
      },
      {
        label: "Evidence and decisions",
        heading: "Deterministic findings remain authoritative.",
        body: "Optional AI review is advisory and cannot downgrade rule findings. Reports retain redacted evidence rather than raw archives by default, and Drydock never publishes a release or collects an approval code.",
      },
    ],
    close: {
      heading: "Check the boundary yourself.",
      body: "The sandbox, the credential separation, and the fail-closed tests are all in the open repository. Read a public diff to see the same review boundary applied without an account.",
      action: { href: "/diff", label: "Read a public diff" },
    },
    primary: { href: "/docs#safety-model", label: "Read the safety guide" },
    secondary: {
      href: "https://github.com/JoviDeCroock/drydock/blob/main/docs/security-model.md",
      label: "Open the engineering model",
    },
  },
  "/open-source": {
    relatedTitle: "Open-source package review",
    heading: "Inspect, verify, and self-host the release-review boundary.",
    lead: "Drydock is Apache-2.0 licensed and its detection rules, sandbox boundaries, report model, and deployment configuration are public. Maintainers can use the hosted service or deploy the same review system in their own Cloudflare account.",
    details: ["Apache-2.0", "public detection rules", "Cloudflare self-hosting"],
    sections: [
      {
        label: "Inspectable rules",
        heading: "A finding should be reviewable, not proprietary magic.",
        body: "Deterministic rule IDs, severities, evidence text, risk computation, regression fixtures, and detection-eval coverage live in the repository. Public package diffs run those deterministic checks without an AI reviewer.",
      },
      {
        label: "Inspectable boundary",
        heading: "The isolation claims are part of the source.",
        body: "The archive parsers, constrained egress gateways, credential separation, redaction, ownership checks, and fail-closed tests can be audited alongside the product behavior they protect.",
      },
      {
        label: "Self-hosting",
        heading: "Operate Drydock in your own Cloudflare account.",
        body: "The repository documents the Worker, D1, Dynamic Worker loader, optional queues and caches, GitHub App, npm connection, and deployment configuration needed to run an independent installation.",
      },
    ],
    close: {
      heading: "Run it, or read it.",
      body: "Use the hosted service, deploy the same Worker in your own Cloudflare account, or start by reading the detection rules and deciding whether you agree with them.",
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
      feedbackPosition="end"
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
