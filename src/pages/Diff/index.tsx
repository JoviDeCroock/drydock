import { useEffect } from "preact/hooks";
import { useComputed, useModel, useSignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { useLocation } from "preact-iso";
import { useCancellableEffect } from "../../lib/use-cancellable-effect";
import type { DiffEntry } from "../../../server/lib/review";
import { BadgeVerdictNotice } from "./BadgeVerdictNotice";
import { SaveReviewAction } from "./SaveReviewAction";
import { TrustEvidence } from "./TrustEvidence";
import { countSeverities } from "../../lib/findings";
import { packageDiffIndexSeo, packageDiffSeo, PageSeo } from "../../lib/seo";
import {
  getPublicDiffVersions,
  PackageDiffModel,
  resolveSuggestedDiffPath,
  type PublicDiffResponse,
} from "../../models/package-diff";
import { errorMessage } from "../../models/api";
import { AikidoPartnerStrip } from "../../components/AikidoPartner";
import { Alert, type AlertTone } from "../../components/Alert";
import { Button, LinkButton } from "../../components/Button";
import { type DiffFinding, DiffView } from "../../components/DiffView";
import { Field } from "../../components/Field";
import { Input } from "../../components/Input";
import { LoadingState } from "../../components/Loading";
import { PageShell } from "../../components/PageShell";
import { hasManifestChanges, PackageJsonDiffView } from "../../components/PackageJsonDiffView";
import { Select } from "../../components/Select";
import { SeverityBar } from "../../components/SeverityBar";
import { VersionPairPicker } from "../../components/VersionPicker";
import {
  EmptyLine,
  LoadingLine,
  MonoDetail,
  Muted,
  SectionLabel,
} from "../../components/Typography";
import {
  packageDiffPath,
  parseDiffPackage,
  parseDiffSpec,
  type DiffEcosystem,
  type DiffSpec,
} from "../../lib/package-diff-path";
import { diffRefLabel, parsePkgPrNewUrl } from "../../lib/pkg-pr-new";
import { supportsPublishedReview } from "../../lib/published-review-ecosystems";
import { isAtpmStagedVersion } from "../../../server/lib/ecosystems/atpm/stage-ref";
import { ecosystemLabel } from "../../../server/lib/ecosystems/labels";
import { IncidentDiffCards } from "../../features/incident-diffs/IncidentDiffCards";
import { InstallProtection } from "../../features/aikido-partner/InstallProtection";
import { DependencyPrIntegrations } from "../../features/dependency-pr-integrations/DependencyPrIntegrations";
import { findingCountsByPath } from "../../features/review/diff-entries";
import { ReviewWorkbench } from "../../features/review/ReviewWorkbench";
import { RiskSignalsSection } from "../../features/review/RiskSignalsSection";
import type { FindingWithDiffStatus } from "../../features/review/types";
import { useSelectedDiffFile } from "../../features/review/useSelectedDiffFile";
import { MarketingHeaderActions } from "../MarketingHeaderActions";
import { useAuthedSession } from "../useAuthedSession";

export default function DiffPage() {
  const location = useLocation();
  const spec = parseDiffSpec(location.path);
  if (spec) {
    if (spec.ecosystem === "atpm" && spec.packageName.startsWith("@")) {
      return <AtpmDiffCanonicalizer key={spec.packageName} spec={spec} />;
    }
    return (
      <PackageDiffView
        key={`${spec.ecosystem}:${spec.packageName}@${spec.fromVersion}..${spec.toVersion}`}
        spec={spec}
      />
    );
  }
  // Package-only form (/diff/<name>, /diff/pypi/<name>): the target of
  // added-dependency links and of the sitemap's package pages, where there is
  // no version pair to link directly. Resolve the latest published pair and
  // redirect.
  const index = parseDiffPackage(location.path);
  if (index) {
    return (
      <DiffPackageResolver
        key={`${index.ecosystem}:${index.packageName}`}
        ecosystem={index.ecosystem}
        packageName={index.packageName}
      />
    );
  }
  return <DiffLanding />;
}

function AtpmDiffCanonicalizer({ spec }: { spec: DiffSpec }) {
  const authed = useAuthedSession();
  const location = useLocation();
  const error = useSignal<string | null>(null);

  useCancellableEffect(
    (isCancelled) => {
      void getPublicDiffVersions("atpm", spec.packageName).then(
        (versions) => {
          if (isCancelled()) return;
          if (versions.packageName === spec.packageName) {
            error.value = "This package did not resolve to a canonical publisher DID.";
            return;
          }
          location.route(
            packageDiffPath("atpm", versions.packageName, spec.fromVersion, spec.toVersion),
            true,
          );
        },
        (err) => {
          if (!isCancelled()) error.value = errorMessage(err);
        },
      );
    },
    [spec.packageName, spec.fromVersion, spec.toVersion],
  );

  return (
    <PageShell headerActions={<MarketingHeaderActions authed={authed} />}>
      <PageSeo
        metadata={packageDiffSeo(
          spec.packageName,
          spec.fromVersion,
          spec.toVersion,
          spec.ecosystem,
        )}
      />
      <section class="flex flex-col gap-4 border-t border-border pt-6">
        <h1 class="text-3xl md:text-4xl font-semibold tracking-[-0.02em] leading-[1.1] m-0 [overflow-wrap:anywhere]">
          {spec.packageName}
        </h1>
        <MonoDetail parts={["public package diff"]} />
        <Show
          when={error}
          fallback={
            <LoadingState
              title="Pinning publisher identity"
              detail="resolving the package handle to its canonical DID"
            />
          }
        >
          {(message) => <DiffFailureNotice message={message} />}
        </Show>
      </section>
    </PageShell>
  );
}

function DiffPackageResolver({
  ecosystem,
  packageName,
}: {
  ecosystem: DiffEcosystem;
  packageName: string;
}) {
  const authed = useAuthedSession();
  const location = useLocation();
  const error = useSignal<string | null>(null);

  useCancellableEffect(
    (isCancelled) => {
      void resolveSuggestedDiffPath(ecosystem, packageName).then((resolved) => {
        if (isCancelled()) return;
        if ("error" in resolved) error.value = resolved.error;
        else location.route(resolved.path, true);
      });
    },
    [ecosystem, packageName],
  );

  return (
    <PageShell headerActions={<MarketingHeaderActions authed={authed} />}>
      {/* Its own canonical, not `/diff`. This page redirects to the latest
          pair, but it is the stable URL a sitemap or an inbound link can name,
          so it has to describe this package rather than the diff tool. */}
      <PageSeo metadata={packageDiffIndexSeo(ecosystem, packageName)} />
      <section class="flex flex-col gap-4 border-t border-border pt-6">
        <h1 class="text-3xl md:text-4xl font-semibold tracking-[-0.02em] leading-[1.1] m-0 [overflow-wrap:anywhere]">
          {packageName}
        </h1>
        <MonoDetail parts={["public package diff"]} />
        <Show
          when={error}
          fallback={
            <LoadingState
              title="Finding versions"
              detail="resolving the latest published version pair"
            />
          }
        >
          {(message) => <DiffFailureNotice message={message} />}
        </Show>
      </section>
    </PageShell>
  );
}

/**
 * The closing ask under a diff of two published versions, per ecosystem.
 *
 * The reader has just finished reading and is being told where this review runs
 * before publication — so it has to name the path that actually exists for
 * their registry. npm is the only ecosystem with a staged tarball, PyPI's only
 * pre-publish surface is the workflow gate, and atpm is review-only: Drydock
 * never approves, gates, or watches an atpm release.
 */
const NEXT_RELEASE_ASK: Record<
  DiffEcosystem,
  { body: string; guide: { href: string; label: string } }
> = {
  npm: {
    body:
      "Both versions are already public. For your next release, review a private npm stage or " +
      "add a GitHub workflow gate to your publish job. Staging decisions are advisory; the gate " +
      "controls only the configured protected job.",
    guide: { href: "/npm-staged-publishing", label: "Set up npm staging" },
  },
  pypi: {
    body:
      "Both versions are already public. To review your next PyPI release before publication, " +
      "add a GitHub workflow gate. GitHub holds the configured publish job while you inspect the " +
      "built wheels and source distributions.",
    guide: { href: "/pypi-release-security", label: "Protect a PyPI workflow" },
  },
  atpm: {
    body:
      "Both versions are already public. For your next atpm release, open the candidate's " +
      "Drydock review link from the atpm dashboard before approving it. Approval and publication " +
      "stay with atpm.",
    guide: { href: "/package-tarball-diff", label: "Read how the diff works" },
  },
};

// What the one name field asks for, per ecosystem. Kept as data rather than a
// chain of ternaries so a fourth ecosystem is a row, not another branch.
const NAME_FIELD: Record<DiffEcosystem, { label: string; placeholder: string }> = {
  npm: {
    label: "npm package name or pkg.pr.new URL",
    placeholder: "package name or pkg.pr.new URL, e.g. react",
  },
  pypi: { label: "PyPI project name", placeholder: "project name, e.g. requests" },
  atpm: {
    label: "atpm package name or publisher DID",
    placeholder: "@handle/name, e.g. @ebey.dev/counter",
  },
};

function isDiffEcosystem(value: string): value is DiffEcosystem {
  return value in NAME_FIELD;
}

function DiffLanding() {
  const authed = useAuthedSession();
  const location = useLocation();
  const ecosystem = useSignal<DiffEcosystem>("npm");
  const packageName = useSignal("");
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const namePlaceholder = useComputed(() => NAME_FIELD[ecosystem.value].placeholder);
  const nameLabel = useComputed(() => NAME_FIELD[ecosystem.value].label);

  const open = async (input: string) => {
    if (!input || busy.peek()) return;
    const eco = ecosystem.peek();
    busy.value = true;
    error.value = null;
    try {
      // A pasted pkg.pr.new URL diffs the preview build against the latest
      // published release of the same package. Previews are npm-only, so the
      // ecosystem selector is ignored for them.
      const preview = parsePkgPrNewUrl(input);
      if (preview) {
        const versions = await getPublicDiffVersions("npm", preview.packageName);
        const published = versions.suggested?.to ?? versions.versions[0]?.version;
        if (!published) {
          error.value = "This package has no published npm release to compare the preview against.";
          return;
        }
        location.route(packageDiffPath("npm", versions.packageName, published, preview.url));
        return;
      }
      const resolved = await resolveSuggestedDiffPath(eco, input);
      if ("error" in resolved) error.value = resolved.error;
      else location.route(resolved.path);
    } catch (err) {
      error.value = errorMessage(err);
    } finally {
      // Guarantee the submit button re-enables even if routing throws, so the
      // form can never wedge on a stuck busy flag.
      busy.value = false;
    }
  };

  return (
    <PageShell class="gap-12" headerActions={<MarketingHeaderActions authed={authed} />}>
      <PageSeo metadata={packageDiffSeo()} />
      <section class="pt-8 pb-2 md:pt-12 border-t border-border flex flex-col gap-5">
        <h1 class="text-4xl md:text-5xl font-semibold tracking-[-0.03em] leading-[1.05] max-w-[760px] m-0">
          Compare npm, PyPI, or atpm releases.
        </h1>
        <p class="text-[17px] text-ink-muted max-w-[620px] leading-[1.6] m-0">
          Compare published versions file by file and inspect supply-chain findings in the diff. You
          can also paste a <span class="font-mono text-[15px]">pkg.pr.new</span> URL to review a
          pull-request preview build. No account needed.
        </p>
        <form
          class="flex flex-wrap gap-3 items-end max-w-[620px]"
          onSubmit={(event) => {
            event.preventDefault();
            void open(packageName.peek().trim());
          }}
        >
          <div class="min-w-[100px]">
            <Field label="Ecosystem" for="diff-ecosystem">
              <Select
                id="diff-ecosystem"
                value={ecosystem}
                onChange={(value) => (ecosystem.value = isDiffEcosystem(value) ? value : "npm")}
              >
                {Object.keys(NAME_FIELD).map((id) => (
                  <option key={id} value={id}>
                    {ecosystemLabel(id)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {/* The visible label stays generic so it can be the accessible name;
              the ecosystem-specific hint (pkg.pr.new URL, project name, DID)
              lives in the placeholder and description. */}
          <Field label="Package" for="diff-package-name" class="flex-1 min-w-[240px]">
            <Input
              id="diff-package-name"
              type="text"
              value={packageName}
              placeholder={namePlaceholder}
              aria-description={nameLabel}
              autoComplete="off"
              spellcheck={false}
              class="w-full"
              onInput={(event) => (packageName.value = (event.target as HTMLInputElement).value)}
            />
          </Field>
          <Button type="submit" disabled={busy}>
            <Show when={busy} fallback="Diff latest versions">
              Loading versions…
            </Show>
          </Button>
        </form>
        <Show when={error}>{(message) => <DiffFailureAlert message={message} />}</Show>
      </section>

      <section class="flex flex-col gap-3" aria-label="Notable supply-chain diffs">
        <SectionLabel as="h2">Explore example diffs</SectionLabel>
        <IncidentDiffCards />
      </section>

      <section class="flex flex-col gap-3">
        <SectionLabel as="h2">Why diff the artifact</SectionLabel>
        <Muted class="m-0 text-[14px] leading-[1.65] max-w-[680px]">
          A package archive can include generated code, bundled dependencies, and install scripts
          that were absent from the pull request. Comparing registry artifacts shows what changed in
          the files users receive.
        </Muted>
        <Muted class="m-0 text-[13px] leading-[1.6] max-w-[680px]">
          This public tool uses deterministic rules to flag changes that need attention. Drydock
          reads the package files without executing their code; AI review is available only on
          authenticated reviews.
        </Muted>
      </section>

      <DependencyPrIntegrations />

      <AikidoPartnerStrip placement="diff" />
    </PageShell>
  );
}

function PackageDiffView({ spec }: { spec: DiffSpec }) {
  const { ecosystem, packageName, fromVersion, toVersion } = spec;
  const authed = useAuthedSession();
  const location = useLocation();
  const model = useModel(
    () => new PackageDiffModel(ecosystem, packageName, fromVersion, toVersion),
  );
  const fileFilter = useSignal("");
  const changedFilesOnly = useSignal(true);

  useEffect(() => {
    void model.load();
  }, []);

  const diffEntries = useComputed<DiffEntry[]>(() => model.diff.value?.diff ?? []);
  const findingItems = useComputed<FindingWithDiffStatus[]>(() => adaptFindings(model.diff.value));
  const findingCounts = useComputed(() => findingCountsByPath(findingItems.value));
  // The bar counts only findings on the release change, so it agrees with the
  // release risk beside it; package-context findings are counted in the
  // metadata line, as the scan-detail verdict separates release from artifact.
  const releaseFindings = useComputed(() =>
    (model.diff.value?.findings ?? []).filter((finding) => finding.releaseDelta === true),
  );
  const severityCounts = useComputed(() => countSeverities(releaseFindings.value));
  const selected = useSelectedDiffFile(diffEntries, model.selectedPath, findingItems);

  const diff = model.diff.value;
  const loading = model.loading.value;
  const error = model.error.value;
  const versions = model.versions.value;
  // The URL carries the canonical name, which for atpm uses the publisher DID.
  // Show the readable spelling once the response supplies one; until then the
  // URL's own name is the only name there is.
  const shownName = diff?.displayName ?? versions?.displayName ?? packageName;
  const changedCount = diff ? diff.diff.filter((entry) => entry.status !== "unchanged").length : 0;
  const hasFindings = Boolean(diff?.findings.length);
  const releaseFindingCount = releaseFindings.value.length;
  const contextFindingCount = (diff?.findings.length ?? 0) - releaseFindingCount;
  // Preview sides (pkg.pr.new URLs) get short labels; registry versions pass
  // through unchanged.
  const fromLabel = diffRefLabel(fromVersion);
  const toLabel = diffRefLabel(toVersion);
  const hasPreview = fromLabel !== fromVersion || toLabel !== toVersion;
  // A staged candidate stands in the `to` slot. The page is otherwise the same
  // review, which is the point — a maintainer deciding whether to publish and a
  // consumer auditing what was published are looking at the same evidence.
  const isStagedReview = isAtpmStagedVersion(toVersion);
  const pickerVersions = versions
    ? [
        ...[fromVersion, toVersion]
          .filter((value) => diffRefLabel(value) !== value)
          .map((value) => ({ version: value, distTags: [], label: diffRefLabel(value) })),
        ...versions.versions,
      ]
    : null;

  return (
    <PageShell headerActions={<MarketingHeaderActions authed={authed} />}>
      <PageSeo
        metadata={packageDiffSeo(packageName, fromVersion, toVersion, ecosystem, shownName)}
      />
      {/* The header says each fact once, as on the scan detail: the metadata
          line is plain text, the SeverityBar counts the findings, and the
          version pair appears in the line only while there is no picker to
          carry it. Whether a staged candidate is published is the expected
          state of that URL, not an alert, so it is plain text too. */}
      <section class="flex flex-col gap-3 border-t border-border pt-6">
        <div class="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div class="flex flex-col gap-3 min-w-0">
            <h1 class="text-3xl md:text-4xl font-semibold tracking-[-0.02em] leading-[1.1] m-0 [overflow-wrap:anywhere]">
              {shownName}
            </h1>
            <MonoDetail
              parts={[
                <span key="review-kind">
                  {isStagedReview ? "staged release review" : "public package diff"}
                </span>,
                isStagedReview ? <span key="unpublished">not yet published</span> : null,
                <span key="ecosystem">{ecosystemLabel(ecosystem)}</span>,
                pickerVersions ? null : (
                  <span key="versions">
                    {fromLabel} → {toLabel}
                  </span>
                ),
                ...(diff
                  ? [
                      <span key="files">{diff.diff.length} files</span>,
                      <span key="changed">{changedCount} changed</span>,
                      <span key="risk">release risk {diff.risk.releaseRisk}</span>,
                      diff.risk.artifactRisk !== diff.risk.releaseRisk ? (
                        <span key="artifact-risk">artifact risk {diff.risk.artifactRisk}</span>
                      ) : null,
                      hasFindings ? null : <span key="findings">no findings</span>,
                      releaseFindingCount === 1 ? (
                        <span key="release-findings">1 release finding</span>
                      ) : null,
                      contextFindingCount ? (
                        <span key="context-findings">
                          {contextFindingCount} package-context{" "}
                          {contextFindingCount === 1 ? "finding" : "findings"}
                        </span>
                      ) : null,
                    ]
                  : []),
              ]}
            />
          </div>
          {/* A preview ref is mutable, so there is nothing stable to save it as.
              The ecosystem check gates the mount, not the render: the action
              loads the reader's organizations, which an ecosystem that cannot
              be saved must not spend a request on. */}
          {hasPreview || !supportsPublishedReview(ecosystem) ? null : (
            <Show when={authed}>
              <SaveReviewAction spec={spec} />
            </Show>
          )}
        </div>
        {/* One segment would only restate the single finding the line names. */}
        {releaseFindingCount > 1 ? (
          <SeverityBar
            counts={severityCounts.value}
            label="release findings by severity"
            class="max-w-[420px]"
          />
        ) : null}
        {error ? null : (
          <Muted class="m-0 text-[13px] leading-[1.6] max-w-[680px]">
            Deterministic findings only: package code is never executed and AI review does not run
            on this public surface, so the same version pair always produces the same report.
          </Muted>
        )}
        {pickerVersions ? (
          <VersionPairPicker
            versions={pickerVersions}
            fromVersion={fromVersion}
            toVersion={toVersion}
            onChange={(nextFrom, nextTo) =>
              location.route(packageDiffPath(ecosystem, packageName, nextFrom, nextTo))
            }
          />
        ) : null}
      </section>

      {error ? <DiffFailureNotice message={error} onRetry={() => void model.load()} /> : null}
      {loading ? (
        <LoadingState
          title="Comparing releases"
          detail="fetching published artifacts · parsing in the sandbox · computing the diff"
        />
      ) : null}

      {diff ? (
        <>
          {/* The click target of the README badge, so the claim that earned the
              click is stated here; the model only sets it for this exact
              version, and it points at the diff, so it waits for one. */}
          <Show when={model.badgeVerdict}>
            {(verdict) => <BadgeVerdictNotice verdict={verdict} />}
          </Show>
          {diff.notices?.length ? (
            <Alert tone="warn">
              {diff.notices.map((notice) => (
                <p key={notice} class="m-0">
                  {notice}
                </p>
              ))}
            </Alert>
          ) : null}

          {diff.provenance?.length || diff.attestation ? (
            <TrustEvidence provenance={diff.provenance ?? []} attestation={diff.attestation} />
          ) : null}
          <ReviewWorkbench
            entries={diffEntries}
            fileFilter={fileFilter}
            changedFilesOnly={changedFilesOnly}
            selectedPath={model.selectedPath}
            findingCounts={findingCounts}
            onSelect={(path) => void model.selectPath(path)}
          >
            <PublicDiffWorkbench
              entry={selected.entry.value}
              model={model}
              fromVersion={fromLabel}
              toVersion={toLabel}
              findings={selected.findings.value}
            />
          </ReviewWorkbench>

          {hasManifestChanges(diff.packageJsonDiff) ? (
            <section class="flex flex-col gap-3">
              <SectionLabel as="h2">Manifest changes</SectionLabel>
              {/* npm only. PyPI requirement rows are not npm packages at all,
                  and an atpm dependency spelled `@handle/name` would resolve on
                  npm to a same-named scope someone else owns — a confidently
                  wrong link is worse than none. */}
              <PackageJsonDiffView
                diff={diff.packageJsonDiff}
                linkDependencyDiffs={diff.ecosystem === "npm"}
              />
            </section>
          ) : null}

          {hasFindings ? (
            <RiskSignalsSection
              findings={findingItems.value}
              onSelect={(file) => void model.selectPath(file)}
            />
          ) : null}

          <section class="flex flex-col gap-3 pt-3">
            <SectionLabel as="p">Before it ships</SectionLabel>
            <h2 class="text-2xl font-semibold tracking-[-0.015em] m-0">
              {hasPreview ? "This is the review that matters." : "This diff is after the fact."}
            </h2>
            <Muted class="m-0 text-[14px] leading-[1.65] max-w-[680px]">
              {isStagedReview
                ? "This is an atpm release candidate that has not been published yet. Drydock " +
                  "reviews the candidate's content-addressed bytes from the publisher's public " +
                  "repository; approving or withdrawing it still happens in atpm."
                : hasPreview
                  ? "One side of this diff is a pkg.pr.new preview build that has not been " +
                    "published yet. Drydock runs this same review automatically on staged npm " +
                    "publishes and GitHub-gated releases — while there is still time to say no. " +
                    "The maintainer keeps the final decision."
                  : NEXT_RELEASE_ASK[ecosystem].body}
            </Muted>
            <div class="flex gap-3 mt-1">
              {/* A signed-in reader already has the next step in the header
                  (save this review); an anonymous one comes back to this diff
                  after creating an account instead of an empty dashboard. */}
              <Show when={() => !authed.value}>
                <LinkButton href={`/register?returnTo=${encodeURIComponent(location.url)}`}>
                  Review my next release
                </LinkButton>
              </Show>
              <LinkButton href={NEXT_RELEASE_ASK[ecosystem].guide.href} variant="secondary">
                {NEXT_RELEASE_ASK[ecosystem].guide.label}
              </LinkButton>
            </div>
          </section>

          {(ecosystem === "npm" || ecosystem === "pypi") && !hasPreview ? (
            <InstallProtection />
          ) : (
            <AikidoPartnerStrip placement="diff" />
          )}
        </>
      ) : null}
    </PageShell>
  );
}

function PublicDiffWorkbench({
  entry,
  model,
  fromVersion,
  toVersion,
  findings,
}: {
  entry: DiffEntry | null;
  model: InstanceType<typeof PackageDiffModel>;
  fromVersion: string;
  toVersion: string;
  findings: DiffFinding[];
}) {
  const fileLoading = model.fileLoading.value;
  const fileError = model.fileError.value;
  const file = model.file.value;

  if (!entry) {
    return (
      <div class="flex flex-1 flex-col items-center justify-center min-h-0">
        <EmptyLine>No changed files between these versions.</EmptyLine>
      </div>
    );
  }
  if (fileError) {
    return <Alert tone="warn">{fileError}</Alert>;
  }
  if (fileLoading || !file || file.path !== entry.path) {
    return (
      <div class="flex flex-1 flex-col items-center justify-center min-h-0">
        <LoadingLine>Loading file contents</LoadingLine>
      </div>
    );
  }
  return (
    <DiffView
      path={entry.path}
      status={entry.status}
      before={file.before}
      after={file.after}
      beforeLabel={fromVersion}
      afterLabel={toVersion}
      findings={findings}
    />
  );
}

// Projects a public-diff response into the shared review shape. This surface
// persists nothing, so the findings have no scan-backed identity — the index is
// a stable-enough render key within one computed diff.
function adaptFindings(diff: PublicDiffResponse | null): FindingWithDiffStatus[] {
  if (!diff) return [];
  return diff.findings.map((finding, index) => ({
    finding: {
      id: `public-${index}`,
      severity: finding.severity,
      file: finding.file,
      evidence: finding.evidence,
      reason: finding.reason,
      line: finding.line ?? null,
      source: "rule",
      ruleId: finding.ruleId ?? null,
    },
    diffStatus: finding.diffStatus,
    releaseDelta: finding.releaseDelta,
    releaseDeltaKind: finding.releaseDeltaKind,
  }));
}

interface DiffFailure {
  title: string;
  body: string;
  tone: AlertTone;
  retry: boolean;
}

// The server reports failures as short lowercase reasons ("package not found",
// "rate limit exceeded"). Map the ones a reader can act on to a named failure
// and a next step; the raw reason stays underneath as the mono detail line.
function describeDiffFailure(message: string): DiffFailure {
  const reason = message.toLowerCase();
  if (reason.includes("rate limit")) {
    return {
      title: "Too many comparisons",
      body: "The public diff limits how often one visitor can compare releases. Wait a minute, then try again.",
      tone: "warn",
      retry: true,
    };
  }
  if (reason.includes("preview not found")) {
    return {
      title: "Preview build not found",
      body: "pkg.pr.new has no preview at this URL. Check the link, or compare published versions instead.",
      tone: "warn",
      retry: false,
    };
  }
  if (reason.includes("not found") || reason.includes("does not exist")) {
    return {
      title: "Package not found",
      body: "The registry has no package or release under this name. Check the spelling, or choose another package.",
      tone: "warn",
      retry: false,
    };
  }
  if (
    reason.includes("too large") ||
    reason.includes("too many files") ||
    reason.includes("size limit")
  ) {
    return {
      title: "Release too large to diff",
      body: "This release exceeds the public diff size limits, so Drydock did not compare it.",
      tone: "warn",
      retry: false,
    };
  }
  if (reason.includes("at least two published versions") || reason.includes("no published")) {
    return {
      title: "Nothing to compare yet",
      body: "This package needs an earlier published release to compare against.",
      tone: "warn",
      retry: false,
    };
  }
  return {
    title: "Diff unavailable",
    body: "Drydock could not compare these releases. Try again, or choose another package.",
    tone: "critical",
    retry: true,
  };
}

function DiffFailureAlert({ message }: { message: string }) {
  const failure = describeDiffFailure(message);
  return (
    <Alert tone={failure.tone}>
      <h2 class="m-0 text-[13px] font-medium">{failure.title}</h2>
      <p class="m-0 text-ink-muted leading-[1.55]">{failure.body}</p>
      <p class="m-0 mt-1 font-mono text-[12px] text-ink-subtle [overflow-wrap:anywhere]">
        {message}
      </p>
    </Alert>
  );
}

/**
 * A failed diff page: what failed, then a way forward. Without the actions the
 * page is a dead end, since the header holds no form to try another package.
 */
function DiffFailureNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const canRetry = Boolean(onRetry) && describeDiffFailure(message).retry;
  return (
    <section class="flex flex-col gap-3">
      <DiffFailureAlert message={message} />
      <div class="flex flex-wrap gap-3">
        {canRetry ? <Button onClick={onRetry}>Try again</Button> : null}
        <LinkButton href="/diff" variant={canRetry ? "secondary" : "primary"}>
          Choose another package
        </LinkButton>
      </div>
    </section>
  );
}
