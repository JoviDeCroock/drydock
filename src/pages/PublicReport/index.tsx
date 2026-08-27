import { useEffect } from "preact/hooks";
import { useComputed, useSignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { useRoute } from "preact-iso";
import { formatDateTime } from "../../lib/format";
import { sortFindingsBySeverity } from "../../lib/findings";
import { Alert } from "../../components/Alert";
import { Badge, severityTone, statusTone } from "../../components/Badge";
import { Card } from "../../components/Card";
import { FindingCard } from "../../components/FindingCard";
import { LoadingState } from "../../components/Loading";
import { PageShell } from "../../components/PageShell";
import { LinkButton } from "../../components/Button";
import { EmptyLine, MonoDetail, Muted, SectionLabel } from "../../components/Typography";
import { verdictTextClass } from "../../features/review/verdict";
import { MarketingHeaderActions } from "../MarketingHeaderActions";
import { useAuthedSession } from "../useAuthedSession";

// The canonical report export served at /public/reports/:token — the same
// document `serializeReportExport` produces (schema drydock.report.v2).
interface PublicReport {
  schema: string;
  scan: {
    id: string;
    status: string;
    source: string;
    risk: string;
    decision: string | null;
    createdAt: string | null;
    completedAt: string | null;
  };
  package: {
    name: string | null;
    stagedVersion: string | null;
    previousVersion: string | null;
  };
  riskSummary: {
    releaseRisk: string;
    contextRisk: string;
    releaseFindingCount: number;
    contextFindingCount: number;
  } | null;
  diff: Array<{ path: string; status: string }> | null;
  findings: Array<{
    severity: string;
    file: string;
    line: number | null;
    ruleId: string | null;
    diffStatus: string | null;
    releaseDelta: boolean | null;
    evidence: string;
    reason: string;
  }>;
}

interface LoadedPublicReport {
  data: PublicReport;
  attestationAvailable: boolean;
}

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
  const report = useSignal<LoadedPublicReport | null>(null);
  const errorState = useSignal<"none" | "not_found" | "failed">("none");
  // The prerendered `/reports` document is also the shell served for every
  // `/reports/:token` request (see `assetFallbackRequest`), so the explainer
  // must not be in the server-rendered output — a share link would flash "there
  // is no public index" before the bundle takes over. Deferring it to the
  // client keeps the loading skeleton as the shell for both.
  const mounted = useSignal(false);
  useEffect(() => {
    mounted.value = true;
  }, []);

  useEffect(() => {
    let cancelled = false;
    report.value = null;
    errorState.value = "none";
    if (!hasShareToken(token)) return;
    void (async () => {
      const keyRequest = fetch("/public/attestation-key", {
        headers: { accept: "application/json" },
      }).catch(() => null);
      try {
        const res = await fetch(`/public/reports/${encodeURIComponent(token)}`, {
          headers: { accept: "application/json" },
        });
        if (cancelled) return;
        if (res.status === 404) {
          errorState.value = "not_found";
          return;
        }
        if (!res.ok) {
          errorState.value = "failed";
          return;
        }
        const data = (await res.json()) as PublicReport;
        const keyResponse = await keyRequest;
        if (!cancelled) {
          report.value = { data, attestationAvailable: keyResponse?.ok ?? false };
        }
      } catch {
        if (!cancelled) errorState.value = "failed";
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    const data = report.value?.data;
    if (data?.package.name) {
      document.title = `${data.package.name} ${data.package.stagedVersion ?? ""} · Drydock review`;
    }
    // report is a signal; this effect re-runs via the render below, which is
    // enough for a one-shot title update after load.
  }, [report.value]);

  const sortedFindings = useComputed(() =>
    report.value ? sortFindingsBySeverity(report.value.data.findings) : [],
  );
  const changedFiles = useComputed(
    () => report.value?.data.diff?.filter((entry) => CHANGED_STATUSES.has(entry.status)) ?? [],
  );

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
            the files the release changed — served read-only at its own link.
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

  if (errorState.value === "not_found") {
    return (
      <PageShell width="doc" headerActions={<MarketingHeaderActions authed={authed} />}>
        <Alert tone="critical">
          This report link is invalid or has been revoked by the publisher.
        </Alert>
      </PageShell>
    );
  }
  if (errorState.value === "failed") {
    return (
      <PageShell width="doc" headerActions={<MarketingHeaderActions authed={authed} />}>
        <Alert tone="critical">The report could not be loaded. Try again in a minute.</Alert>
      </PageShell>
    );
  }

  const loaded = report.value;
  if (!loaded) {
    return (
      <PageShell width="doc" headerActions={<MarketingHeaderActions authed={authed} />}>
        <LoadingState title="Loading public review" detail="fetching report" />
      </PageShell>
    );
  }

  const { data, attestationAvailable } = loaded;

  const releaseRisk = data.riskSummary?.releaseRisk ?? data.scan.risk;
  const decision = data.scan.decision;
  const attestationHref = `/public/reports/${encodeURIComponent(token)}/attestation`;
  const findings = sortedFindings.value;
  const changes = changedFiles.value;

  return (
    <PageShell width="doc" headerActions={<MarketingHeaderActions authed={authed} />}>
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

      <section class="flex flex-col gap-3">
        <SectionLabel as="h2">Verify this report</SectionLabel>
        {attestationAvailable ? (
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
          {attestationAvailable ? (
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
