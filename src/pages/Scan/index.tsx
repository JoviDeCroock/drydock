import { useState } from "preact/hooks";
import { runScan } from "../../models/scan";
import type { DiffEntry, Finding } from "../../../server/lib/review";
import type { AiFinding } from "../../../server/lib/ai-review";
import type { ScanResult } from "../../../server/types";

type Status = "idle" | "scanning" | "done" | "error";

export function ScanPage() {
  const [stageId, setStageId] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);

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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  };

  return (
    <main class="page">
      <header class="page-header">
        <h1>Staged Publish Sandbox</h1>
        <p>
          Sandboxed npm staged tarball review with deterministic checks, version diffing, and AI triage.
          The npm token stays in the parent worker; the Dynamic Worker sandbox only sees the staged
          tarball through a locked-down gateway.
        </p>
      </header>

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
            {status === "scanning" ? "Scanning…" : "Scan"}
          </button>
        </div>
      </form>

      {error ? <div class="banner banner-error">{error}</div> : null}
      {result ? <ScanResultView result={result} /> : null}
    </main>
  );
}

function ScanResultView({ result }: { result: ScanResult }) {
  const ai = result.aiFindings;
  const changed = result.diff.filter((entry) => entry.status !== "unchanged");

  return (
    <section class="result">
      <div class="result-summary">
        <SummaryCell label="package" value={result.package.name || "unknown"} />
        <SummaryCell
          label="version"
          value={`${result.package.previousVersion || "—"} → ${result.package.stagedVersion || "—"}`}
        />
        <SummaryCell
          label="risk"
          value={<span class={`risk risk-${result.risk}`}>{result.risk}</span>}
        />
        <SummaryCell label="files" value={`${result.fileCount} (${changed.length} changed)`} />
        <SummaryCell label="ai risk" value={<span class={`risk risk-${ai?.risk ?? "low"}`}>{ai?.risk ?? "—"}</span>} />
        <SummaryCell label="manual review" value={ai?.requiresManualReview ? "yes" : "no"} />
      </div>

      {ai?.summary ? <p class="ai-summary">{ai.summary}</p> : null}

      <h2>Deterministic findings ({result.ruleFindings.length})</h2>
      <RuleFindingList findings={result.ruleFindings} />

      <h2>AI findings ({ai?.findings?.length ?? 0})</h2>
      <AiFindingList findings={ai?.findings ?? []} />

      <h2>Changed files ({changed.length})</h2>
      <DiffList entries={changed} />

      <details class="safety">
        <summary>Safety posture</summary>
        <pre>{JSON.stringify(result.safety, null, 2)}</pre>
      </details>

      {result.packageJson ? (
        <details class="package">
          <summary>package.json</summary>
          <pre>{JSON.stringify(result.packageJson, null, 2)}</pre>
        </details>
      ) : null}
    </section>
  );
}

function SummaryCell({ label, value }: { label: string; value: preact.ComponentChildren }) {
  return (
    <div>
      <span class="muted">{label}</span>
      <code>{value}</code>
    </div>
  );
}

function RuleFindingList({ findings }: { findings: Finding[] }) {
  if (!findings.length) return <p class="muted">No findings.</p>;
  return (
    <ul class="findings">
      {findings.map((f, i) => (
        <li key={`${f.file}-${i}`} class={`finding sev-${f.severity}`}>
          <div class="finding-head">
            <span class={`badge sev-${f.severity}`}>{f.severity}</span>
            <code>{f.file}</code>
          </div>
          <div class="finding-body">
            <div>
              <span class="muted">evidence:</span> {f.evidence}
            </div>
            <div>
              <span class="muted">reason:</span> {f.reason}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function AiFindingList({ findings }: { findings: AiFinding[] }) {
  if (!findings.length) return <p class="muted">No findings.</p>;
  return (
    <ul class="findings">
      {findings.map((f, i) => (
        <li key={`${f.file}-${i}`} class={`finding sev-${f.severity}`}>
          <div class="finding-head">
            <span class={`badge sev-${f.severity}`}>{f.severity}</span>
            <code>{f.file}</code>
          </div>
          <div class="finding-body">
            <div>
              <span class="muted">evidence:</span> {f.evidence}
            </div>
            <div>
              <span class="muted">reason:</span> {f.reason}
            </div>
            {f.recommendation ? (
              <div>
                <span class="muted">recommendation:</span> {f.recommendation}
              </div>
            ) : null}
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
          <span class="muted">
            {entry.previousSize ?? 0} → {entry.stagedSize ?? 0} bytes
          </span>
        </li>
      ))}
    </ul>
  );
}
