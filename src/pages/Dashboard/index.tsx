import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { useLocation } from "preact-iso";
import { getSession, signOut, type AuthSession } from "../../models/auth";
import { listScans, runScan, type ScanListItem } from "../../models/scan";
import type { DiffEntry, Finding } from "../../../server/lib/review";
import type { AiFinding } from "../../../server/lib/ai-review";
import type { ScanResult } from "../../../server/types";

type Status = "idle" | "checking" | "scanning" | "done" | "error";

export default function DashboardPage() {
  const location = useLocation();
  const [session, setSession] = useState<AuthSession | null>(null);
  const [stageId, setStageId] = useState("");
  const [status, setStatus] = useState<Status>("checking");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [scans, setScans] = useState<ScanListItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    getSession().then(async (current) => {
      if (cancelled) return;
      if (!current) {
        location.route("/login", true);
        return;
      }
      setSession(current);
      setStatus("idle");
      await refreshScans();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshScans() {
    try {
      setScans(await listScans());
    } catch {
      // Keep the scan form usable even if persisted scan listing fails.
    }
  }

  const onSubmit = async (event: Event) => {
    event.preventDefault();
    if (!stageId.trim()) return;
    setStatus("scanning");
    setError(null);
    setResult(null);
    try {
      const data = await runScan(stageId.trim());
      setResult(data);
      setStatus("done");
      await refreshScans();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  };

  const onSignOut = async () => {
    await signOut();
    location.route("/", true);
  };

  if (status === "checking") {
    return <main class="page"><div class="panel">Checking session…</div></main>;
  }

  return (
    <main class="page dashboard-page">
      <header class="page-header dashboard-header">
        <div>
          <p class="eyebrow">Authenticated dashboard</p>
          <h1>Staged Publish Review</h1>
          <p>
            Review npm staged packages through a sandboxed Dynamic Worker, deterministic release checks,
            previous-version diffs, and Kimi K2.5 triage.
          </p>
        </div>
        <div class="account-pill">
          <span>{session?.user.email || session?.user.name || "signed in"}</span>
          <button type="button" class="button secondary small" onClick={onSignOut}>Sign out</button>
        </div>
      </header>

      <section class="panel">
        <form class="scan-form" onSubmit={onSubmit}>
          <label for="stageId">Stage ID</label>
          <div class="row">
            <input
              id="stageId"
              type="text"
              value={stageId}
              placeholder="e.g. acme-pkg-1.2.3-stage-abcdef"
              onInput={(e) => setStageId((e.target as HTMLInputElement).value)}
              disabled={status === "scanning"}
              autoComplete="off"
              spellcheck={false}
            />
            <button type="submit" disabled={status === "scanning" || !stageId.trim()}>
              {status === "scanning" ? "Scanning…" : "Scan staged publish"}
            </button>
          </div>
        </form>
        {error ? <div class="banner banner-error">{error}</div> : null}
      </section>

      {result ? <ScanResultView result={result} /> : null}

      <section class="panel persisted-scans">
        <div class="section-heading">
          <h2>Recent scans</h2>
          <button type="button" class="button secondary small" onClick={refreshScans}>Refresh</button>
        </div>
        {scans.length ? <ScanTable scans={scans} /> : <p class="muted">No persisted scans yet.</p>}
      </section>
    </main>
  );
}

function ScanResultView({ result }: { result: ScanResult }) {
  const ai = result.aiFindings;
  const changed = result.diff.filter((entry) => entry.status !== "unchanged");

  return (
    <section class="result panel">
      <div class="result-summary">
        <SummaryCell label="package" value={result.package.name || "unknown"} />
        <SummaryCell
          label="version"
          value={`${result.package.previousVersion || "—"} → ${result.package.stagedVersion || "—"}`}
        />
        <SummaryCell label="risk" value={<span class={`risk risk-${result.risk}`}>{result.risk}</span>} />
        <SummaryCell label="files" value={`${result.fileCount} (${changed.length} changed)`} />
        <SummaryCell label="AI assessment" value={ai.releaseAssessment.replaceAll("_", " ")} />
        <SummaryCell label="manual review" value={ai.requiresManualReview ? "yes" : "no"} />
      </div>

      {ai.summary ? <p class="ai-summary">{ai.summary}</p> : null}

      <h2>Deterministic findings ({result.ruleFindings.length})</h2>
      <RuleFindingList findings={result.ruleFindings} />

      <h2>AI findings ({ai.findings.length})</h2>
      <AiFindingList findings={ai.findings} />

      <h2>Changed files ({changed.length})</h2>
      <DiffList entries={changed} />

      <details class="safety">
        <summary>Safety posture</summary>
        <pre>{JSON.stringify(result.safety, null, 2)}</pre>
      </details>
    </section>
  );
}

function ScanTable({ scans }: { scans: ScanListItem[] }) {
  return (
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Package</th>
            <th>Version</th>
            <th>Risk</th>
            <th>Status</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {scans.map((scan) => (
            <tr key={scan.id}>
              <td><a href={`/dashboard/scans/${encodeURIComponent(scan.id)}`}>{scan.packageName || scan.stageId}</a></td>
              <td>{scan.previousVersion || "—"} → {scan.stagedVersion || "—"}</td>
              <td><span class={`risk risk-${scan.risk}`}>{scan.risk}</span></td>
              <td>{scan.status}</td>
              <td>{formatDate(scan.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SummaryCell({ label, value }: { label: string; value: ComponentChildren }) {
  return (
    <div>
      <span class="muted">{label}</span>
      <code>{value}</code>
    </div>
  );
}

function RuleFindingList({ findings }: { findings: Finding[] }) {
  if (!findings.length) return <p class="muted">No deterministic findings.</p>;
  return (
    <ul class="findings">
      {findings.map((f, i) => (
        <li key={`${f.file}-${i}`} class={`finding sev-${f.severity}`}>
          <div class="finding-head">
            <span class={`badge sev-${f.severity}`}>{f.severity}</span>
            <code>{f.file}</code>
          </div>
          <div class="finding-body">
            <div><span class="muted">evidence:</span> {f.evidence}</div>
            <div><span class="muted">reason:</span> {f.reason}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function AiFindingList({ findings }: { findings: AiFinding[] }) {
  if (!findings.length) return <p class="muted">No AI findings.</p>;
  return (
    <ul class="findings">
      {findings.map((f, i) => (
        <li key={`${f.file}-${i}`} class={`finding sev-${f.severity}`}>
          <div class="finding-head">
            <span class={`badge sev-${f.severity}`}>{f.severity}</span>
            <code>{f.file}</code>
          </div>
          <div class="finding-body">
            <div><span class="muted">evidence:</span> {f.evidence}</div>
            <div><span class="muted">reason:</span> {f.reason}</div>
            <div><span class="muted">recommendation:</span> {f.recommendation}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function DiffList({ entries }: { entries: DiffEntry[] }) {
  if (!entries.length) return <p class="muted">No changes detected.</p>;
  return (
    <ul class="diff">
      {entries.map((entry) => (
        <li key={entry.path} class={`diff-entry status-${entry.status}`}>
          <span class={`badge status-${entry.status}`}>{entry.status}</span>
          <code>{entry.path}</code>
          <span class="muted">{entry.previousSize ?? 0} → {entry.stagedSize ?? 0} bytes</span>
        </li>
      ))}
    </ul>
  );
}

function formatDate(value: ScanListItem["createdAt"]) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}
