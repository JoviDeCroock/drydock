import { useEffect, useState } from "preact/hooks";
import { useLocation, useRoute } from "preact-iso";
import { getSession } from "../../models/auth";
import { getScan, type PersistedScanDetail } from "../../models/scan";

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
        setSelectedPath(data.files.find((file) => file.status !== "unchanged")?.path ?? data.files[0]?.path ?? null);
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
    <main class="page detail-page">
      <header class="page-header">
        <a class="back-link" href="/dashboard">← Dashboard</a>
        <h1>{detail?.scan.packageName || "Scan detail"}</h1>
        {detail ? (
          <p>
            {detail.scan.previousVersion || "—"} → {detail.scan.stagedVersion || "—"} · <span class={`risk risk-${detail.scan.risk}`}>{detail.scan.risk}</span>
          </p>
        ) : <p class="muted">Loading persisted scan…</p>}
      </header>

      {error ? <div class="banner banner-error">{error}</div> : null}

      {detail ? (
        <section class="detail-grid">
          <aside class="panel file-list-panel">
            <h2>Files</h2>
            <div class="files">
              {detail.files.map((file) => (
                <button
                  type="button"
                  key={file.path}
                  class={selectedPath === file.path ? "selected" : ""}
                  onClick={() => setSelectedPath(file.path)}
                >
                  <span class={`badge status-${file.status}`}>{file.status}</span>
                  <span>{file.path}</span>
                </button>
              ))}
            </div>
          </aside>

          <section class="panel preview-panel">
            <h2>Safe text preview</h2>
            {selected ? (
              <>
                <p class="muted">{selected.path} · {selected.size ?? 0} bytes · {selected.sha256 || "no hash"}</p>
                <pre>{selected.textSample || "No text sample stored. Binary, empty, or truncated before preview."}</pre>
              </>
            ) : <p class="muted">Select a file.</p>}
          </section>

          <aside class="panel findings-panel">
            <h2>Findings</h2>
            {detail.findings.length ? (
              <ul class="findings compact">
                {detail.findings.map((finding) => (
                  <li key={finding.id} class={`finding sev-${finding.severity}`}>
                    <div class="finding-head">
                      <span class={`badge sev-${finding.severity}`}>{finding.severity}</span>
                      <code>{finding.file}</code>
                    </div>
                    <div class="finding-body">
                      <div><span class="muted">evidence:</span> {finding.evidence}</div>
                      <div><span class="muted">reason:</span> {finding.reason}</div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : <p class="muted">No deterministic findings.</p>}
          </aside>
        </section>
      ) : null}
    </main>
  );
}
