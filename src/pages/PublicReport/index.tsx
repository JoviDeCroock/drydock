import { useEffect } from "preact/hooks";
import { useModel, useSignal, useSignalEffect } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { useRoute } from "preact-iso";
import { formatDateTime } from "../../lib/format";
import { sortFindingsBySeverity } from "../../lib/findings";
import { useQuerySignal } from "../../lib/query-state";
import {
  hasNoLoadableBody,
  PublicReportModel,
  type PublicReport,
} from "../../models/public-report";
import { Alert } from "../../components/Alert";
import { Badge, severityTone, statusTone } from "../../components/Badge";
import { Card } from "../../components/Card";
import { FindingCard } from "../../components/FindingCard";
import { LoadingState } from "../../components/Loading";
import { PageShell } from "../../components/PageShell";
import { LinkButton } from "../../components/Button";
import { EmptyLine, MonoDetail, Muted, SectionLabel } from "../../components/Typography";
import { ReviewWorkbench } from "../../features/review/ReviewWorkbench";
import { RiskSignalsSection } from "../../features/review/RiskSignalsSection";
import { verdictTextClass } from "../../features/review/verdict";
import { MarketingHeaderActions } from "../MarketingHeaderActions";
import { useAuthedSession } from "../useAuthedSession";
import { ReportDiffPanel } from "./ReportDiffPanel";

const CHANGED_STATUSES = new Set(["added", "removed", "modified"]);
const MAX_LISTED_CHANGES = 200;

/**
 * The share token *is* the capability, so `/reports` with no token is not a
 * revoked link — it is someone who trimmed the URL, or a chat client that cut
 * the token off the end. That state gets an explainer, and never a lookup: an
 * empty token would only 404 and render "invalid or revoked" at a visitor who
 * was never given a link in the first place.
 */
export function hasShareToken(token: string | null | undefined): boolean {
  return typeof token === "string" && token.trim() !== "";
}

export default function PublicReportPage() {
  const route = useRoute();
  const token = route.params.token ?? "";
  const tokenPresent = hasShareToken(token);
  const authed = useAuthedSession();
  const model = useModel(() => new PublicReportModel());
  const fileFilter = useSignal("");
  const changedFilesOnly = useSignal(true);
  // The prerendered `/reports` document is also the shell served for every
  // `/reports/:token` request (see `assetFallbackRequest`), so the explainer
  // must not be in the server-rendered output — a share link would flash "there
  // is no public index" before the bundle takes over. Deferring it to the
  // client keeps the loading skeleton as the shell for both.
  const mounted = useSignal(false);
  useEffect(() => {
    mounted.value = true;
  }, []);

  // Deep-linkable review state, exactly as the authenticated workbench binds it,
  // so a maintainer can share a link that opens on the file they mean.
  useQuerySignal(fileFilter, {
    name: "file",
    parse: (raw) => raw ?? "",
    serialize: (value) => value || null,
    debounceMs: 250,
  });
  useQuerySignal(changedFilesOnly, {
    name: "changedOnly",
    parse: (raw) => raw !== "0",
    serialize: (value) => (value ? null : "0"),
  });
  useQuerySignal(model.selectedPath, {
    name: "path",
    parse: (raw) => raw ?? null,
    serialize: (value) => value,
  });

  useEffect(() => {
    if (!hasShareToken(token)) return;
    void model.load(token);
  }, [token]);

  // Open on the release delta. A shared report exists to be read, and landing
  // on "select a file" makes the reader do the work of finding the change.
  useSignalEffect(() => {
    const includesFiles = model.includesFiles.value;
    const entries = model.diffEntries.value;
    if (!includesFiles || !entries.length || model.selectedPath.peek()) return;
    // Prefer a file with a staged body: a `removed` entry is a legitimate first
    // change but its contents belong to the previous version, so landing there
    // opens the report on an explanation instead of on the diff.
    const first =
      entries.find((entry) => entry.status === "modified" || entry.status === "added") ??
      entries.find((entry) => entry.status !== "unchanged") ??
      entries[0];
    if (first) model.selectPath(first.path);
  });

  useSignalEffect(() => {
    const includesFiles = model.includesFiles.value;
    const entry = model.selectedEntry.value;
    if (!includesFiles || !entry || entry.status === "removed") return;
    if (hasNoLoadableBody(entry.flags)) return;
    void model.loadFile(entry.path);
  });

  useEffect(() => {
    const data = model.report.value;
    if (data?.package.name) {
      document.title = `${data.package.name} ${data.package.stagedVersion ?? ""} · Drydock review`;
    }
    // report is a signal; this effect re-runs via the render below, which is
    // enough for a one-shot title update after load.
  }, [model.report.value]);

  if (!tokenPresent) {
    if (!mounted.value) {
      return (
        <PageShell width="doc" headerActions={<MarketingHeaderActions authed={authed} />}>
          <LoadingState title="Loading public review" detail="fetching report" />
        </PageShell>
      );
    }
    return (
      <PageShell width="doc" headerActions={<MarketingHeaderActions authed={authed} />}>
        <header class="flex flex-col gap-2">
          <p class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle m-0">
            Public release review
          </p>
          <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">This page needs a link</h1>
          <Muted class="m-0 text-[14px] leading-[1.65] max-w-[680px]">
            A Drydock public report is a single release review that the package's owner chose to
            share: the same canonical report export Drydock produced for them — risk, findings, and
            the diff the release actually shipped — served read-only at its own link.
          </Muted>
        </header>

        <Card class="flex flex-col gap-3">
          <SectionLabel as="h2">Why there is no index</SectionLabel>
          <EmptyLine>
            The link is the permission. Each report has its own unguessable address, reports are
            never listed or searchable, and the owner can revoke a link at any time — so{" "}
            <code class="font-mono text-[12px] text-ink">/reports</code> on its own has nothing to
            show. If someone sent you a report, open their full link: chat clients and mail readers
            sometimes cut the token off the end.
          </EmptyLine>
        </Card>

        <section class="flex flex-col gap-3">
          <SectionLabel as="h2">Where to go next</SectionLabel>
          <EmptyLine>
            You can diff any published npm, PyPI, or atpm package against its previous version
            without an account, or read how staged reviews, sharing, and signed attestations work.
          </EmptyLine>
          <div class="flex flex-wrap gap-2">
            <LinkButton href="/diff">Diff a package</LinkButton>
            <LinkButton href="/docs" variant="secondary">
              Read the docs
            </LinkButton>
          </div>
        </section>
      </PageShell>
    );
  }

  if (model.errorState.value === "not_found") {
    return (
      <PageShell width="doc" headerActions={<MarketingHeaderActions authed={authed} />}>
        <Alert tone="critical">
          This report link is invalid or has been revoked by the publisher.
        </Alert>
      </PageShell>
    );
  }
  if (model.errorState.value === "failed") {
    return (
      <PageShell width="doc" headerActions={<MarketingHeaderActions authed={authed} />}>
        <Alert tone="critical">The report could not be loaded. Try again in a minute.</Alert>
      </PageShell>
    );
  }

  const data = model.report.value;
  if (!data) {
    return (
      <PageShell width="doc" headerActions={<MarketingHeaderActions authed={authed} />}>
        <LoadingState title="Loading public review" detail="fetching report" />
      </PageShell>
    );
  }

  const releaseRisk = data.riskSummary?.releaseRisk ?? data.scan.risk;
  const decision = data.scan.decision;
  const attestationHref = `/public/reports/${encodeURIComponent(token)}/attestation`;
  const changedCount = model.diffEntries.value.filter(
    (entry) => entry.status !== "unchanged",
  ).length;

  return (
    <PageShell headerActions={<MarketingHeaderActions authed={authed} />}>
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div class="flex flex-col gap-2 min-w-0">
          <p class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle m-0">
            Public release review
          </p>
          <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">
            {data.package.name || "Release review"}
          </h1>
          <MonoDetail
            parts={[
              <span key="version">
                {data.package.previousVersion || "—"} → {data.package.stagedVersion || "—"}
              </span>,
              data.scan.completedAt ? (
                <span key="completed">reviewed {formatDateTime(data.scan.completedAt)}</span>
              ) : null,
              <span key="changed">
                {changedCount} changed {changedCount === 1 ? "file" : "files"}
              </span>,
              <span key="findings">
                {data.findings.length} finding{data.findings.length === 1 ? "" : "s"}
              </span>,
            ]}
          />
        </div>
        <div class="flex flex-col items-end gap-1">
          <Badge tone={severityTone(releaseRisk)}>release {releaseRisk}</Badge>
          {decision ? (
            <Badge tone={decision === "publish" ? "ok" : "critical"}>
              {decision === "publish" ? "approved" : "blocked"}
            </Badge>
          ) : null}
        </div>
      </header>

      <Card class="flex flex-col gap-3">
        <SectionLabel as="h2">Verdict</SectionLabel>
        <p
          class={`m-0 text-[18px] font-semibold tracking-[-0.01em] ${verdictTextClass(releaseRisk)}`}
        >
          Release risk: {releaseRisk}
        </p>
        <EmptyLine>
          Deterministic review of the staged release against its previous version
          {data.riskSummary
            ? ` — ${data.riskSummary.releaseFindingCount} release finding${
                data.riskSummary.releaseFindingCount === 1 ? "" : "s"
              }, ${data.riskSummary.contextFindingCount} pre-existing.`
            : "."}
        </EmptyLine>
      </Card>

      <Show when={model.includesFiles} fallback={<EvidenceOnlyReport data={data} />}>
        {() => (
          <>
            <ReviewWorkbench
              entries={model.diffEntries}
              fileFilter={fileFilter}
              changedFilesOnly={changedFilesOnly}
              selectedPath={model.selectedPath}
              findingCounts={model.findingCounts}
              onSelect={(path) => model.selectPath(path)}
            >
              <ReportDiffPanel
                entry={model.selectedEntry.value}
                file={model.selectedFile.value}
                loading={model.loadingPath.value === model.selectedPath.value}
                missing={Boolean(
                  model.selectedPath.value && model.fileMisses.value[model.selectedPath.value],
                )}
                stagedVersion={data.package.stagedVersion}
                findings={model.selectedFindings.value}
              />
            </ReviewWorkbench>

            <RiskSignalsSection
              findings={model.findingItems.value}
              onSelect={(file) => model.selectPath(file)}
              description={
                "Deterministic rules scanned the full staged artifact. Changed-file signals are pinned " +
                "to their line in the diff above; unchanged signals stay here as package context."
              }
            />
          </>
        )}
      </Show>

      <section class="flex flex-col gap-3">
        <SectionLabel as="h2">Verify this report</SectionLabel>
        {model.attestationAvailable.value ? (
          <EmptyLine>
            The signed attestation covers the exact JSON served for this link: its subject digest is
            the SHA-256 of the report bytes, signed with Drydock's Ed25519 key (DSSE envelope, key
            published at{" "}
            <a
              href="/public/attestation-key"
              target="_blank"
              rel="noreferrer"
              class="text-ink-muted underline hover:text-ink"
            >
              /public/attestation-key
            </a>
            ).
          </EmptyLine>
        ) : (
          <EmptyLine>Signed attestations are not configured for this deployment.</EmptyLine>
        )}
        <div class="flex flex-wrap gap-2">
          {model.attestationAvailable.value ? (
            <LinkButton variant="secondary" size="sm" href={attestationHref} download>
              Download attestation
            </LinkButton>
          ) : null}
          <LinkButton
            variant="ghost"
            size="sm"
            href={`/public/reports/${encodeURIComponent(token)}`}
            download
          >
            Download report JSON
          </LinkButton>
        </div>
      </section>

      <section class="flex flex-col gap-3 pt-3">
        <SectionLabel as="p">Before it ships</SectionLabel>
        <h2 class="text-2xl font-semibold tracking-[-0.015em] m-0">
          This release was reviewed while it could still be stopped.
        </h2>
        <Muted class="m-0 text-[14px] leading-[1.65] max-w-[680px]">
          The publisher held this release — an npm staged publish or a GitHub-gated job —{" "}
          {decision === "publish"
            ? "and read this report before letting it ship."
            : decision
              ? "read this report, and stopped it from shipping."
              : "and is reading this report before deciding whether it ships."}{" "}
          Drydock runs the same review on every version you publish; the maintainer keeps the final
          decision. You can also diff any published npm, PyPI, or atpm package without an account.
        </Muted>
        <div class="flex flex-wrap gap-3 mt-1">
          <Show
            when={authed}
            fallback={
              <>
                <LinkButton href="/register">Create account</LinkButton>
                <LinkButton href="/diff" variant="secondary">
                  Diff a package
                </LinkButton>
              </>
            }
          >
            <LinkButton href="/diff">Diff a package</LinkButton>
          </Show>
        </div>
      </section>
    </PageShell>
  );
}

function EvidenceOnlyReport({ data }: { data: PublicReport }) {
  const findings = sortFindingsBySeverity(data.findings);
  const changes = data.diff?.filter((entry) => CHANGED_STATUSES.has(entry.status)) ?? [];

  return (
    <>
      <Muted class="m-0 text-[13px] leading-[1.6] max-w-[760px]">
        This link was created before shared file diffs were available. The maintainer can open this
        review in Drydock and re-share it to include the diff.
      </Muted>

      {findings.length ? (
        <section class="flex flex-col gap-3">
          <SectionLabel as="h2">Risk signals</SectionLabel>
          <ul class="list-none p-0 m-0 flex flex-col gap-3">
            {findings.map((finding, index) => (
              <FindingCard
                key={`${finding.file}:${finding.ruleId ?? index}:${finding.line ?? ""}`}
                severity={finding.severity}
                file={finding.file}
                line={finding.line}
                ruleId={finding.ruleId}
                diffStatus={finding.diffStatus}
              >
                <p class="m-0">{finding.reason}</p>
                {finding.evidence ? (
                  <code class="font-mono text-[12px] text-ink-muted break-all">
                    {finding.evidence}
                  </code>
                ) : null}
              </FindingCard>
            ))}
          </ul>
        </section>
      ) : (
        <section class="flex flex-col gap-3">
          <SectionLabel as="h2">Risk signals</SectionLabel>
          <EmptyLine>No deterministic findings in this release.</EmptyLine>
        </section>
      )}

      {changes.length ? (
        <section class="flex flex-col gap-3">
          <SectionLabel as="h2">Release changes</SectionLabel>
          <ul class="list-none p-0 m-0 flex flex-col gap-1.5">
            {changes.slice(0, MAX_LISTED_CHANGES).map((entry) => (
              <li key={entry.path} class="flex items-center gap-2 min-w-0">
                <Badge tone={statusTone(entry.status)} class="flex-shrink-0">
                  {entry.status}
                </Badge>
                <code class="font-mono text-[13px] text-ink-muted truncate" title={entry.path}>
                  {entry.path}
                </code>
              </li>
            ))}
          </ul>
          {changes.length > MAX_LISTED_CHANGES ? (
            <EmptyLine>
              And {changes.length - MAX_LISTED_CHANGES} more changed files in the full report.
            </EmptyLine>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
