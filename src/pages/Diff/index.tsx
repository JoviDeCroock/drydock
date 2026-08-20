import { useEffect } from "preact/hooks";
import { useComputed, useModel, useSignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { useLocation } from "preact-iso";
import type { DiffEntry } from "../../../server/lib/review";
import { compareSeverity, countSeverities } from "../../lib/findings";
import { packageDiffSeo, PageSeo } from "../../lib/seo";
import {
  getPublicDiffVersions,
  PackageDiffModel,
  resolveSuggestedDiffPath,
  type PublicDiffAttestation,
  type PublicDiffResponse,
} from "../../models/package-diff";
import { errorMessage } from "../../models/api";
import { AikidoPartnerStrip } from "../../components/AikidoPartner";
import { Alert } from "../../components/Alert";
import { Badge, severityTone } from "../../components/Badge";
import { Button, LinkButton } from "../../components/Button";
import { Card } from "../../components/Card";
import { type DiffFinding, DiffView } from "../../components/DiffView";
import { FileTree } from "../../components/FileTree";
import { Input } from "../../components/Input";
import { LoadingState } from "../../components/Loading";
import { PageShell } from "../../components/PageShell";
import { hasManifestChanges, PackageJsonDiffView } from "../../components/PackageJsonDiffView";
import { Select } from "../../components/Select";
import { SeverityBar } from "../../components/SeverityBar";
import {
  EmptyLine,
  Eyebrow,
  LoadingLine,
  MonoDetail,
  MonoLabel,
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
import { isAtpmStagedVersion } from "../../../server/lib/ecosystems/atpm/stage-ref";
import { ecosystemLabel } from "../../../server/lib/ecosystems/labels";
import { IncidentDiffCards } from "../../features/incident-diffs/IncidentDiffCards";
import { filterDiffEntries, findingCountsByPath } from "../../features/review/diff-entries";
import { RiskSignalsSection } from "../../features/review/RiskSignalsSection";
import type { FindingWithDiffStatus } from "../../features/review/types";
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
  // Package-only form (/diff/<name>): the target of added-dependency links,
  // where there is no version pair to link directly. Resolve the latest
  // published pair and redirect. npm-only — dependency links are suppressed
  // for ecosystems whose dependencies are not npm packages.
  const packageName = parseDiffPackage(location.path);
  if (packageName) return <DiffPackageResolver key={packageName} packageName={packageName} />;
  return <DiffLanding />;
}

function AtpmDiffCanonicalizer({ spec }: { spec: DiffSpec }) {
  const authed = useAuthedSession();
  const location = useLocation();
  const error = useSignal<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getPublicDiffVersions("atpm", spec.packageName).then(
      (versions) => {
        if (cancelled) return;
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
        if (!cancelled) error.value = errorMessage(err);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [spec.packageName, spec.fromVersion, spec.toVersion]);

  return (
    <PageShell headerActions={<MarketingHeaderActions authed={authed} />} feedbackPosition="end">
      <PageSeo
        metadata={packageDiffSeo(
          spec.packageName,
          spec.fromVersion,
          spec.toVersion,
          spec.ecosystem,
        )}
      />
      <section class="flex flex-col gap-4 border-t border-border pt-6">
        <Eyebrow tone="accent">Public package diff</Eyebrow>
        <h1 class="text-3xl md:text-4xl font-semibold tracking-[-0.02em] leading-[1.1] m-0 break-all">
          {spec.packageName}
        </h1>
        <Show
          when={error}
          fallback={
            <LoadingState
              title="Pinning publisher identity"
              detail="resolving the package handle to its canonical DID"
            />
          }
        >
          {(message) => <Alert tone="critical">{message}</Alert>}
        </Show>
      </section>
    </PageShell>
  );
}

function DiffPackageResolver({ packageName }: { packageName: string }) {
  const authed = useAuthedSession();
  const location = useLocation();
  const error = useSignal<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void resolveSuggestedDiffPath("npm", packageName).then((resolved) => {
      if (cancelled) return;
      if ("error" in resolved) error.value = resolved.error;
      else location.route(resolved.path, true);
    });
    return () => {
      cancelled = true;
    };
  }, [packageName]);

  return (
    <PageShell headerActions={<MarketingHeaderActions authed={authed} />} feedbackPosition="end">
      <PageSeo metadata={packageDiffSeo()} />
      <section class="flex flex-col gap-4 border-t border-border pt-6">
        <Eyebrow tone="accent">Public package diff</Eyebrow>
        <h1 class="text-3xl md:text-4xl font-semibold tracking-[-0.02em] leading-[1.1] m-0 break-all">
          {packageName}
        </h1>
        <Show
          when={error}
          fallback={
            <LoadingState
              title="Finding versions"
              detail="resolving the latest published version pair"
            />
          }
        >
          {(message) => <Alert tone="critical">{message}</Alert>}
        </Show>
      </section>
    </PageShell>
  );
}

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
    <PageShell headerActions={<MarketingHeaderActions authed={authed} />} feedbackPosition="end">
      <PageSeo metadata={packageDiffSeo()} />
      <section class="py-8 md:py-12 border-t border-border flex flex-col gap-5">
        <Eyebrow tone="accent">Public package diff</Eyebrow>
        <h1 class="text-4xl md:text-5xl font-semibold tracking-[-0.03em] leading-[1.05] max-w-[760px] m-0">
          Diff any npm, PyPI, or atpm package.
        </h1>
        <p class="text-[17px] text-ink-muted max-w-[620px] leading-[1.6] m-0">
          See exactly what changed between two published versions — every file, line by line, with
          the same deterministic supply-chain checks Drydock runs on staged releases. Paste a{" "}
          <span class="font-mono text-[15px]">pkg.pr.new</span> URL to review a pull-request preview
          build before it ships. No account needed.
        </p>
        <form
          class="flex flex-wrap gap-3 items-center max-w-[620px]"
          onSubmit={(event) => {
            event.preventDefault();
            void open(packageName.peek().trim());
          }}
        >
          <div class="w-auto min-w-[100px]">
            <Select
              aria-label="Package ecosystem"
              value={ecosystem}
              onChange={(value) => (ecosystem.value = isDiffEcosystem(value) ? value : "npm")}
            >
              {Object.keys(NAME_FIELD).map((id) => (
                <option key={id} value={id}>
                  {ecosystemLabel(id)}
                </option>
              ))}
            </Select>
          </div>
          <Input
            type="text"
            value={packageName}
            placeholder={namePlaceholder}
            aria-label={nameLabel}
            autoComplete="off"
            spellcheck={false}
            class="flex-1 min-w-[240px]"
            onInput={(event) => (packageName.value = (event.target as HTMLInputElement).value)}
          />
          <Button type="submit" disabled={busy}>
            <Show when={busy} fallback="Diff latest versions">
              Loading versions…
            </Show>
          </Button>
        </form>
        <Show when={error}>{(message) => <Alert tone="critical">{message}</Alert>}</Show>
      </section>

      <section class="flex flex-col gap-3" aria-label="Notable supply-chain diffs">
        <SectionLabel as="h2">See a real incident</SectionLabel>
        <IncidentDiffCards />
      </section>

      <section class="flex flex-col gap-3">
        <SectionLabel as="h2">Why diff the artifact</SectionLabel>
        <Muted class="m-0 text-[14px] leading-[1.65] max-w-[680px]">
          Registry tarballs can differ from the repository: build output, install scripts, and files
          that never saw a pull request all ship in the artifact. Diffing the published bytes is how
          compromised releases like axios and node-ipc were spotted — after they shipped. Drydock
          runs the same review before a release goes live.
        </Muted>
        <Muted class="m-0 text-[13px] leading-[1.6] max-w-[680px]">
          Every finding on this page comes from Drydock's deterministic rules — the package code is
          never executed and no AI reviews this surface, so the same versions always produce the
          same report.
        </Muted>
      </section>

      <AikidoPartnerStrip />
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

  const findingItems = useComputed<FindingWithDiffStatus[]>(() => adaptFindings(model.diff.value));
  const findingCounts = useComputed(() => findingCountsByPath(findingItems.value));
  const severityCounts = useComputed(() => countSeverities(model.diff.value?.findings ?? []));
  const visibleEntries = useComputed(() =>
    filterDiffEntries(model.diff.value?.diff ?? [], fileFilter.value, changedFilesOnly.value),
  );
  const selectedEntry = useComputed<DiffEntry | null>(() => {
    const path = model.selectedPath.value;
    const entries = model.diff.value?.diff ?? [];
    if (!path) return null;
    return entries.find((entry) => entry.path === path) ?? null;
  });
  const selectedFindings = useComputed<DiffFinding[]>(() => {
    const path = model.selectedPath.value;
    const items = findingItems.value;
    if (!path) return [];
    return items
      .filter((item) => item.finding.file === path)
      .slice()
      .sort((a, b) => compareSeverity(a.finding.severity, b.finding.severity))
      .map((item) => ({
        id: item.finding.id,
        severity: item.finding.severity,
        line: item.finding.line,
        ruleId: item.finding.ruleId,
        reason: item.finding.reason,
        evidence: item.finding.evidence,
      }));
  });

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
    <PageShell headerActions={<MarketingHeaderActions authed={authed} />} feedbackPosition="end">
      <PageSeo
        metadata={packageDiffSeo(packageName, fromVersion, toVersion, ecosystem, shownName)}
      />
      <section class="flex flex-col gap-3 border-t border-border pt-6">
        <Eyebrow tone="accent">
          {isStagedReview ? "Staged release review" : "Public package diff"}
        </Eyebrow>
        <h1 class="text-3xl md:text-4xl font-semibold tracking-[-0.02em] leading-[1.1] m-0 break-all">
          {shownName}
        </h1>
        <MonoDetail
          parts={[
            <span key="ecosystem">{ecosystemLabel(ecosystem)}</span>,
            <span key="versions">
              {fromLabel} → {toLabel}
            </span>,
            ...(diff
              ? [
                  <span key="files">{diff.diff.length} files</span>,
                  <span key="changed">{changedCount} changed</span>,
                ]
              : []),
          ]}
        />
        {diff ? (
          <div class="flex flex-wrap items-center gap-2">
            {/* Leads the badges: whether this is already published changes what
                the reader is being asked to do with the rest of the page. */}
            {isStagedReview ? <Badge tone="medium">not yet published</Badge> : null}
            <Badge tone={severityTone(diff.risk.releaseRisk)}>
              release risk {diff.risk.releaseRisk}
            </Badge>
            <Badge tone={diff.findings.length ? "medium" : "ok"}>
              {diff.findings.length
                ? `${diff.findings.length} finding${diff.findings.length === 1 ? "" : "s"}`
                : "no findings"}
            </Badge>
          </div>
        ) : null}
        {hasFindings ? <SeverityBar counts={severityCounts.value} class="max-w-[420px]" /> : null}
        <Muted class="m-0 text-[13px] leading-[1.6] max-w-[680px]">
          Deterministic findings only: package code is never executed and AI review does not run on
          this public surface, so the same version pair always produces the same report.
        </Muted>
        {diff?.provenance?.length ? <ResolutionTrail steps={diff.provenance} /> : null}
        {diff?.attestation ? <BuildProvenance attestation={diff.attestation} /> : null}
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

      {error ? <Alert tone="critical">{error}</Alert> : null}
      {loading ? (
        <LoadingState
          title="Comparing releases"
          detail="fetching published artifacts · parsing in the sandbox · computing the diff"
        />
      ) : null}

      {diff ? (
        <>
          {diff.notices?.length ? (
            <Alert tone="warn">
              {diff.notices.map((notice) => (
                <p key={notice} class="m-0">
                  {notice}
                </p>
              ))}
            </Alert>
          ) : null}
          <section class="grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)] gap-4">
            <Card as="aside" class="p-5 flex flex-col gap-3 lg:h-[720px] overflow-hidden">
              <SectionLabel as="h2">Release tree</SectionLabel>
              <Input
                type="search"
                value={fileFilter}
                placeholder="Filter files"
                onInput={(e) => (fileFilter.value = (e.target as HTMLInputElement).value)}
                autoComplete="off"
                spellcheck={false}
              />
              <div class="flex flex-wrap items-center justify-between gap-2">
                <label class="flex items-center gap-2 text-[13px] text-ink-muted">
                  <input
                    type="checkbox"
                    checked={changedFilesOnly.value}
                    onChange={(e) =>
                      (changedFilesOnly.value = (e.target as HTMLInputElement).checked)
                    }
                  />
                  Changed files only
                </label>
                <span class="font-mono text-[11px] text-ink-subtle">
                  {visibleEntries.value.length} / {diff.diff.length}
                </span>
              </div>
              <div class="flex flex-col overflow-y-auto flex-1 min-h-0 border-t border-border pt-2">
                <FileTree
                  entries={visibleEntries.value}
                  selectedPath={model.selectedPath.value}
                  onSelect={(path) => void model.selectPath(path)}
                  findingCounts={findingCounts.value}
                />
              </div>
            </Card>

            <Card class="p-5 flex flex-col gap-3 lg:h-[720px]">
              <SectionLabel as="h2">File diff</SectionLabel>
              <PublicDiffWorkbench
                entry={selectedEntry.value}
                model={model}
                fromVersion={fromLabel}
                toVersion={toLabel}
                findings={selectedFindings.value}
              />
            </Card>
          </section>

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
              description={
                `Deterministic rules scan the full ${toLabel} artifact. Changed-file signals ` +
                "are pinned to their line in the diff above; unchanged signals stay here as " +
                "package context. No AI is involved on this surface."
              }
            />
          ) : null}

          <section class="flex flex-col gap-3 pt-3">
            <SectionLabel as="p">Before it ships</SectionLabel>
            <h2 class="text-2xl font-semibold tracking-[-0.015em] m-0">
              {hasPreview ? "This is the review that matters." : "This diff is after the fact."}
            </h2>
            <Muted class="m-0 text-[14px] leading-[1.65] max-w-[680px]">
              {hasPreview
                ? "One side of this diff is a pkg.pr.new preview build that has not been " +
                  "published yet. Drydock runs this same review automatically on staged npm " +
                  "publishes and GitHub-gated releases — while there is still time to say no. " +
                  "The maintainer keeps the final decision."
                : "Both of these versions are already public. Drydock runs this same review on " +
                  "the release candidate — an npm staged publish or a GitHub-gated release — " +
                  "while there is still time to say no. The maintainer keeps the final decision."}
            </Muted>
            <div class="flex gap-3 mt-1">
              <LinkButton href="/register">Create account</LinkButton>
              <LinkButton href="/docs" variant="secondary">
                Read the docs
              </LinkButton>
            </div>
          </section>

          <AikidoPartnerStrip />
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

interface VersionOption {
  version: string;
  distTags: string[];
  /** Display override for preview entries whose value is a pkg.pr.new URL. */
  label?: string;
}

// How the reviewed bytes were located, for ecosystems that resolve a release
// through a chain of independent authorities instead of one registry. On an
// atpm diff this is the substance of the page's claim — a handle proved through
// DNS, a DID through a directory, bytes from the publisher's own server — so it
// sits in the header next to the version pair rather than in a footnote.
//
// Rendered as text, never as links: every value here comes from data the
// publisher under review controls.
function ResolutionTrail({ steps }: { steps: PublicDiffResponse["provenance"] }) {
  return (
    <dl class="flex flex-col gap-1 m-0 max-w-[680px]">
      {steps.map((step) => (
        <div key={`${step.label}:${step.value}`} class="flex flex-wrap items-baseline gap-x-2">
          <MonoLabel as="dt" class="min-w-[64px]">
            {step.label}
          </MonoLabel>
          <dd class="font-mono text-[12px] text-ink-muted m-0 break-all">
            {step.value}
            {step.detail ? <span class="text-ink-subtle"> via {step.detail}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// Where a release was built, and whether that matches what its publisher said
// should build it.
//
// The two halves are deliberately not collapsed into one verdict. The build
// facts came out of a signature check against Sigstore's root, so they hold
// regardless of anything the package's own record claims; the declaration is the
// publisher's statement of intent, which is only as good as their repository.
// A reader deserves to see which is which, so the block labels the proven side
// and the declared side separately and states plainly when they disagree.
function BuildProvenance({ attestation }: { attestation: PublicDiffAttestation }) {
  const build = attestation.build;
  const declared = attestation.declared;
  const mismatch = isTrustedPublisherMismatch(attestation);

  return (
    <div class="flex flex-col gap-2 max-w-[680px]">
      <div class="flex flex-wrap items-center gap-2">
        <MonoLabel>Build provenance</MonoLabel>
        <Badge tone={buildProvenanceTone(attestation)}>{buildProvenanceLabel(attestation)}</Badge>
        {declared?.allowPublish ? <Badge tone="medium">CI publishes unattended</Badge> : null}
      </div>
      {build ? (
        <dl class="flex flex-col gap-1 m-0">
          <ProvenanceRow label="Repo" value={build.repository} />
          {build.workflow ? <ProvenanceRow label="Workflow" value={build.workflow} /> : null}
          {build.ref ? <ProvenanceRow label="Ref" value={build.ref} /> : null}
          {build.commit ? <ProvenanceRow label="Commit" value={build.commit} /> : null}
          {build.runUrl ? <ProvenanceRow label="Run" value={build.runUrl} /> : null}
          {build.runnerEnvironment ? (
            <ProvenanceRow label="Runner" value={build.runnerEnvironment} />
          ) : null}
          {build.logIndex ? <ProvenanceRow label="Rekor" value={build.logIndex} /> : null}
        </dl>
      ) : null}
      {declared ? (
        <dl class="flex flex-col gap-1 m-0">
          <ProvenanceRow label="Declared" value={declared.repository} detail={declared.workflow} />
        </dl>
      ) : null}
      <Muted class="m-0 text-[12px] leading-[1.6]">
        {buildProvenanceExplanation(attestation, mismatch)}
      </Muted>
    </div>
  );
}

function ProvenanceRow({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div class="flex flex-wrap items-baseline gap-x-2">
      <MonoLabel as="dt" class="min-w-[64px]">
        {label}
      </MonoLabel>
      <dd class="font-mono text-[12px] text-ink-muted m-0 break-all">
        {value}
        {detail ? <span class="text-ink-subtle"> · {detail}</span> : null}
      </dd>
    </div>
  );
}

function buildProvenanceTone(attestation: PublicDiffAttestation) {
  if (attestation.status === "invalid" || attestation.status === "mismatch") {
    return "high" as const;
  }
  if (attestation.status === "verified") {
    return isTrustedPublisherMismatch(attestation) ? ("high" as const) : ("ok" as const);
  }
  return "medium" as const;
}

function buildProvenanceLabel(attestation: PublicDiffAttestation) {
  if (attestation.status === "verified") return "verified";
  if (attestation.status === "mismatch") return "different artifact";
  if (attestation.status === "invalid") return "does not verify";
  if (attestation.status === "absent") return "not attested";
  return "not checked";
}

function buildProvenanceExplanation(attestation: PublicDiffAttestation, mismatch: boolean) {
  if (attestation.status === "invalid") {
    return `This version carries a build attestation that does not verify: ${attestation.reason ?? "unreadable"}. Nothing about where it was built can be concluded from it.`;
  }
  if (attestation.status === "mismatch") {
    return `The signature is valid, but it does not describe this release: ${attestation.reason ?? "the package or digest differs"}. The build details below belong to another artifact.`;
  }
  if (attestation.status === "absent") {
    return attestation.declared
      ? "This package declares a trusted publishing workflow, but this version carries no attestation proving it came from one."
      : "This version carries no build attestation, so where it was built is not recorded.";
  }
  if (attestation.status === "not-evaluated") {
    return "This version's attestation was not checked on this page. Older releases of a package with many versions fall outside the per-record verification budget.";
  }
  if (mismatch) {
    if (attestation.match === "workflow-unverified") {
      return "The signature proves the source repository, but the certificate does not identify the workflow that produced this release, so it cannot be matched to the package's trusted-publisher declaration.";
    }
    return "The signature proves where this release was built, and it is not the pipeline this package's own publisher declared as trusted.";
  }
  if (attestation.match === "match") {
    return "Verified against Sigstore's root, and the repository and workflow match the trusted publisher this package declares. Transparency-log inclusion is not independently checked.";
  }
  return "Verified against Sigstore's root. The package declares no trusted publisher to compare it against, so this says where the release was built, not that it was supposed to be built there.";
}

function isTrustedPublisherMismatch(attestation: PublicDiffAttestation): boolean {
  return (
    attestation.match === "repository-mismatch" ||
    attestation.match === "workflow-mismatch" ||
    attestation.match === "workflow-unverified"
  );
}

function VersionPairPicker({
  versions,
  fromVersion,
  toVersion,
  onChange,
}: {
  versions: VersionOption[];
  fromVersion: string;
  toVersion: string;
  onChange: (fromVersion: string, toVersion: string) => void;
}) {
  return (
    <div class="flex flex-wrap items-center gap-3">
      <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">Compare</span>
      <VersionSelect
        label="From version"
        versions={versions}
        selected={fromVersion}
        disabledVersion={toVersion}
        onChange={(version) => onChange(version, toVersion)}
      />
      <span class="font-mono text-[11px] text-ink-muted" aria-hidden>
        →
      </span>
      <VersionSelect
        label="To version"
        versions={versions}
        selected={toVersion}
        disabledVersion={fromVersion}
        onChange={(version) => onChange(fromVersion, version)}
      />
    </div>
  );
}

function VersionSelect({
  label,
  versions,
  selected,
  disabledVersion,
  onChange,
}: {
  label: string;
  versions: VersionOption[];
  selected: string;
  disabledVersion: string;
  onChange: (version: string) => void;
}) {
  return (
    <div class="inline-block w-auto min-w-[160px]">
      <Select
        value={selected}
        size="sm"
        class="font-mono"
        aria-label={label}
        onChange={(value) => {
          if (value && value !== selected) onChange(value);
        }}
      >
        {versions.map((option) => (
          <option
            key={option.version}
            value={option.version}
            disabled={option.version === disabledVersion}
          >
            {option.label ?? option.version}
            {option.distTags.length ? ` [${option.distTags.join(", ")}]` : ""}
          </option>
        ))}
      </Select>
    </div>
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
  }));
}
