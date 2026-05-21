import { useEffect, useState } from "preact/hooks";
import { useLocation, useRoute } from "preact-iso";
import { getSession } from "../../models/auth";
import { getScan, type PersistedScanDetail } from "../../models/scan";
import {
  Alert,
  Badge,
  Card,
  Muted,
  PageShell,
  SectionLabel,
  cn,
  severityTone,
  statusTone,
} from "../../components";
import { FindingItem, FindingRow } from "./index";

export default function ScanDetailPage() {
  const location = useLocation();
  const route = useRoute();
  const id = route.params.id;
  const [detail, setDetail] = useState<PersistedScanDetail | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSession().then(async (current) => {
      if (cancelled) return;
      if (!current) {
        location.route("/login", true);
        return;
      }
      try {
        const data = await getScan(id);
        if (cancelled) return;
        setDetail(data);
        setSelectedPath(
          data.files.find((file) => file.status !== "unchanged")?.path ?? data.files[0]?.path ?? null,
        );
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const selected = detail?.files.find((file) => file.path === selectedPath) ?? null;

  return (
    <PageShell>
      <header class="flex flex-col gap-2">
        <a href="/dashboard" class="text-[13px] text-ink-muted hover:text-ink no-underline">
          ← Dashboard
        </a>
        <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">
          {detail?.scan.packageName || "Scan detail"}
        </h1>
        {detail ? (
          <p class="flex items-center gap-2 text-[13px] text-ink-muted m-0">
            <span class="font-mono">
              {detail.scan.previousVersion || "—"} → {detail.scan.stagedVersion || "—"}
            </span>
            <span>·</span>
            <Badge tone={severityTone(detail.scan.risk)}>{detail.scan.risk}</Badge>
          </p>
        ) : (
          <Muted>Loading persisted scan…</Muted>
        )}
      </header>

      {error ? <Alert tone="critical">{error}</Alert> : null}

      {detail ? (
        <section class="grid grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)_320px] gap-4">
          <Card as="aside" class="p-0 overflow-hidden flex flex-col min-h-0">
            <div class="px-4 py-3 border-b border-border">
              <SectionLabel>Files</SectionLabel>
            </div>
            <div class="flex flex-col overflow-y-auto max-h-[640px]">
              {detail.files.map((file) => {
                const isSelected = selectedPath === file.path;
                return (
                  <button
                    type="button"
                    key={file.path}
                    onClick={() => setSelectedPath(file.path)}
                    class={cn(
                      "flex items-center gap-2 text-left px-4 py-2 border-l-2 transition-colors",
                      "text-[13px] font-mono",
                      isSelected
                        ? "bg-surface-2 border-l-accent text-ink"
                        : "border-l-transparent text-ink-muted hover:bg-surface-2 hover:text-ink",
                    )}
                  >
                    <Badge tone={statusTone(file.status)}>{file.status}</Badge>
                    <span class="truncate flex-1">{file.path}</span>
                  </button>
                );
              })}
            </div>
          </Card>

          <Card class="p-5 flex flex-col gap-3">
            <SectionLabel>Safe text preview</SectionLabel>
            {selected ? (
              <>
                <p class="font-mono text-xs text-ink-muted m-0 break-all">
                  {selected.path} · {selected.size ?? 0} bytes · {selected.sha256 || "no hash"}
                </p>
                <pre class="bg-surface-2 rounded-md p-3 overflow-x-auto text-xs leading-[1.5] m-0 max-h-[560px] overflow-y-auto">
                  {selected.textSample ||
                    "No text sample stored. Binary, empty, or truncated before preview."}
                </pre>
              </>
            ) : (
              <Muted>Select a file.</Muted>
            )}
          </Card>

          <Card as="aside" class="p-5 flex flex-col gap-3">
            <SectionLabel>Findings</SectionLabel>
            {detail.findings.length ? (
              <ul class="list-none p-0 m-0 flex flex-col gap-2">
                {detail.findings.map((finding) => (
                  <FindingItem key={finding.id} severity={finding.severity} file={finding.file}>
                    <FindingRow label="evidence" value={finding.evidence} />
                    <FindingRow label="reason" value={finding.reason} />
                  </FindingItem>
                ))}
              </ul>
            ) : (
              <Muted class="text-[13px]">No deterministic findings.</Muted>
            )}
          </Card>
        </section>
      ) : null}
    </PageShell>
  );
}
