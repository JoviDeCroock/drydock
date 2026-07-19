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
import { Select } from "../../components/Select";
import { SeverityBar } from "../../components/SeverityBar";
import {
  EmptyLine,
  Eyebrow,
  LoadingLine,
  MonoDetail,
  Muted,
  SectionLabel,
} from "../../components/Typography";
import {
  packageDiffPath,
  parseDiffSpec,
  type DiffEcosystem,
  type DiffSpec,
} from "../../lib/package-diff-path";
import { diffRefLabel, parsePkgPrNewUrl } from "../../lib/pkg-pr-new";
import { filterDiffEntries, findingCountsByPath } from "../Dashboard/ScanDetail/diff-helpers";
import { RiskSignalsSection } from "../Dashboard/ScanDetail/FindingsSection";
import type { FindingWithDiffStatus } from "../Dashboard/ScanDetail/types";
import { MarketingHeaderActions } from "../MarketingHeaderActions";
import { useAuthedSession } from "../useAuthedSession";

export default function DiffPage() {
  const location = useLocation();
  const spec = parseDiffSpec(location.path);
  if (!spec) return <DiffLanding />;
  return (
    <PackageDiffView
      key={`${spec.ecosystem}:${spec.packageName}@${spec.fromVersion}..${spec.toVersion}`}
      spec={spec}
    />
  );
}

// Version pairs must exist on the public registry: npm unpublishes malicious
// releases, so the compromised bytes themselves usually cannot be diffed after
// an incident (ua-parser-js's cryptominer, event-stream, coa/rc, and the
// colors sabotage are all gone). Before adding a row, verify both versions
// still resolve AND that the pair surfaces findings — a card that opens a
// clean report undersells the review.
const INCIDENT_DIFFS: Array<DiffSpec & { note: string }> = [
  {
    ecosystem: "npm",
    packageName: "node-ipc",
    fromVersion: "9.2.1",
    toVersion: "11.0.0",
    note: "protestware arrives as a new dependency (peacenotwar)",
  },
  {
    ecosystem: "npm",
    packageName: "semversyphus",
    fromVersion: "1.0.5",
    toVersion: "1.0.6",
    note: "a postinstall script appears — demo of the install-script rule",
  },
  {
    ecosystem: "npm",
    packageName: "es5-ext",
    fromVersion: "0.10.53",
    toVersion: "0.10.54",
    note: "real protestware: a postinstall hook lands in a routine patch, still live on npm",
  },
];

function DiffLanding() {
  const authed = useAuthedSession();
  const location = useLocation();
  const ecosystem = useSignal<DiffEcosystem>("npm");
  const packageName = useSignal("");
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);

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
      const versions = await getPublicDiffVersions(eco, input);
      if (!versions.suggested) {
        error.value = "This package needs at least two published versions to diff.";
        return;
      }
      location.route(
        packageDiffPath(eco, versions.packageName, versions.suggested.from, versions.suggested.to),
      );
    } catch (err) {
      error.value = errorMessage(err);
    } finally {
      busy.value = false;
    }
  };

  return (
    <PageShell headerActions={<MarketingHeaderActions authed={authed} />} feedbackPosition="end">
      <PageSeo metadata={packageDiffSeo()} />
      <section class="py-8 md:py-12 border-t border-border flex flex-col gap-5">
        <Eyebrow tone="accent">Public package diff</Eyebrow>
        <h1 class="text-4xl md:text-5xl font-semibold tracking-[-0.03em] leading-[1.05] max-w-[760px] m-0">
          Diff any npm or PyPI package.
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
          <div class="w-auto min-w-[100px]" aria-label="Package ecosystem">
            <Select
              value={ecosystem.value}
              onChange={(value) => (ecosystem.value = value === "pypi" ? "pypi" : "npm")}
            >
              <option value="npm">npm</option>
              <option value="pypi">PyPI</option>
            </Select>
          </div>
          <Input
            type="text"
            value={packageName}
            placeholder={
              ecosystem.value === "pypi"
                ? "project name, e.g. requests or numpy"
                : "package name or pkg.pr.new URL, e.g. react"
            }
            aria-label={
              ecosystem.value === "pypi"
                ? "PyPI project name"
                : "npm package name or pkg.pr.new URL"
            }
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
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          {INCIDENT_DIFFS.map((incident) => (
            <Card
              key={incident.packageName}
              as="article"
              class="p-5 flex flex-col gap-2 hover:border-accent transition-colors duration-150"
            >
              <a
                href={packageDiffPath(
                  incident.ecosystem,
                  incident.packageName,
                  incident.fromVersion,
                  incident.toVersion,
                )}
                class="flex flex-col gap-2 no-underline text-inherit"
              >
                <h2 class="text-base font-medium tracking-[-0.005em] m-0 break-all">
                  {incident.packageName}
                </h2>
                <span class="font-mono text-[11px] text-ink-subtle">
                  {incident.fromVersion} → {incident.toVersion}
                </span>
                <p class="text-[13px] text-ink-muted leading-[1.55] m-0">{incident.note}</p>
              </a>
            </Card>
          ))}
        </div>
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
  const changedCount = diff ? diff.diff.filter((entry) => entry.status !== "unchanged").length : 0;
  const hasFindings = Boolean(diff?.findings.length);
  // Preview sides (pkg.pr.new URLs) get short labels; registry versions pass
  // through unchanged.
  const fromLabel = diffRefLabel(fromVersion);
  const toLabel = diffRefLabel(toVersion);
  const hasPreview = fromLabel !== fromVersion || toLabel !== toVersion;
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
      <PageSeo metadata={packageDiffSeo(packageName, fromVersion, toVersion, ecosystem)} />
      <section class="flex flex-col gap-3 border-t border-border pt-6">
        <Eyebrow tone="accent">Public package diff</Eyebrow>
        <h1 class="text-3xl md:text-4xl font-semibold tracking-[-0.02em] leading-[1.1] m-0 break-all">
          {packageName}
        </h1>
        <MonoDetail
          parts={[
            <span key="ecosystem">{ecosystem === "pypi" ? "PyPI" : "npm"}</span>,
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
                  "Free for maintainers."
                : "Both of these versions are already public. Drydock runs this same review on " +
                  "the release candidate — an npm staged publish or a GitHub-gated release — " +
                  "while there is still time to say no. Free for maintainers."}
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

function adaptFindings(diff: PublicDiffResponse | null): FindingWithDiffStatus[] {
  if (!diff) return [];
  return diff.findings.map((finding, index) => ({
    finding: {
      id: `public-${index}`,
      scanId: "",
      severity: finding.severity,
      file: finding.file,
      evidence: finding.evidence,
      reason: finding.reason,
      line: finding.line ?? null,
      source: "rule",
      ruleId: finding.ruleId ?? null,
      ruleVersion: finding.ruleVersion ?? null,
      diffStatus: finding.diffStatus,
      releaseDelta: finding.releaseDelta,
    },
    diffStatus: finding.diffStatus,
    releaseDelta: finding.releaseDelta,
  }));
}
