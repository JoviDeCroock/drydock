import { useEffect } from "preact/hooks";
import { useSignal } from "@preact/signals";
import { useRoute } from "preact-iso";
import { formatDateTime } from "../../lib/format";
import {
  Badge,
  Card,
  FindingCard,
  LinkButton,
  LoadingState,
  MonoDetail,
  Muted,
  PageShell,
  SectionLabel,
  severityTone,
} from "../../components";

interface PublicReportExport {
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
    artifactRisk: string;
    contextRisk: string;
  } | null;
  diff: Array<{ path: string; status: string }> | null;
  findings: Array<{
    severity: string;
    file: string;
    line: number | null;
    ruleId: string | null;
    evidence: string;
    reason: string;
  }>;
}

// Read-only shared report view. Loaded through the unauthenticated
// token-gated endpoint; anything rendered here is public to whoever holds
// the link, so it only shows the redacted canonical export.
export default function ReportPage() {
  const route = useRoute();
  const token = route.params.token ?? "";
  const report = useSignal<PublicReportExport | null>(null);
  const failed = useSignal(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/public/reports/${encodeURIComponent(token)}`, {
      headers: { accept: "application/json" },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error("not found");
        const data = (await res.json()) as PublicReportExport;
        if (!cancelled) report.value = data;
      })
      .catch(() => {
        if (!cancelled) failed.value = true;
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (failed.value) {
    return (
      <PageShell width="narrow">
        <Card class="flex flex-col gap-3">
          <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">Report unavailable</h1>
          <Muted class="text-[13px] m-0">
            This share link is invalid or has been revoked by the organization that owns the
            inspection.
          </Muted>
          <div class="mt-2">
            <LinkButton href="/" variant="secondary">
              About Drydock
            </LinkButton>
          </div>
        </Card>
      </PageShell>
    );
  }

  const data = report.value;
  if (!data) {
    return (
      <PageShell width="doc">
        <LoadingState title="Loading shared report" />
      </PageShell>
    );
  }

  const releaseRisk = data.riskSummary?.releaseRisk ?? data.scan.risk;
  const changedFiles = data.diff?.length ?? 0;

  return (
    <PageShell width="doc">
      <div class="flex flex-col gap-6">
        <header class="flex flex-wrap items-start justify-between gap-4">
          <div class="flex flex-col gap-2 min-w-0">
            <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
              Shared inspection report
            </span>
            <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">
              {data.package.name || "Release inspection"}
            </h1>
            <MonoDetail
              parts={[
                <span key="version">
                  {data.package.previousVersion || "—"} → {data.package.stagedVersion || "—"}
                </span>,
                <Badge key="risk" tone={severityTone(releaseRisk)}>
                  release {releaseRisk}
                </Badge>,
                data.scan.decision ? (
                  <Badge key="decision" tone={data.scan.decision === "publish" ? "ok" : "critical"}>
                    {data.scan.decision === "publish" ? "cleared" : "held"}
                  </Badge>
                ) : null,
              ]}
            />
          </div>
          <div class="flex flex-col items-end gap-1">
            {data.scan.completedAt ? (
              <span class="font-mono text-[11px] text-ink-subtle">
                inspected {formatDateTime(data.scan.completedAt)}
              </span>
            ) : null}
            <span class="font-mono text-[11px] text-ink-subtle">
              {changedFiles} changed file{changedFiles === 1 ? "" : "s"} · {data.findings.length}{" "}
              finding{data.findings.length === 1 ? "" : "s"}
            </span>
          </div>
        </header>

        <section class="flex flex-col gap-3">
          <SectionLabel>Findings</SectionLabel>
          {data.findings.length === 0 ? (
            <Card>
              <Muted class="text-[13px] m-0">
                No deterministic findings were raised for this release.
              </Muted>
            </Card>
          ) : (
            data.findings.map((finding, index) => (
              <FindingCard
                key={`${finding.file}-${finding.ruleId ?? index}-${finding.line ?? 0}`}
                severity={finding.severity}
                file={finding.file}
                line={finding.line}
                ruleId={finding.ruleId}
              >
                <p class="m-0 text-[13px] leading-[1.6]">{finding.reason}</p>
                <pre class="m-0 mt-2 font-mono text-[12px] leading-[1.5] text-ink-muted whitespace-pre-wrap break-all">
                  {finding.evidence}
                </pre>
              </FindingCard>
            ))
          )}
        </section>

        <footer class="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <Muted class="text-[13px] m-0">
            Generated by Drydock — deterministic supply-chain checks on the staged release. This is
            a read-only, redacted report; the owning organization can revoke this link at any time.
          </Muted>
          <LinkButton
            variant="ghost"
            size="sm"
            href={`/api/public/reports/${encodeURIComponent(token)}`}
          >
            View JSON
          </LinkButton>
        </footer>
      </div>
    </PageShell>
  );
}
