import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { useLocation } from "preact-iso";
import { getSession, signOut, type AuthSession } from "../../models/auth";
import {
  deleteNpmConnection,
  getNpmConnection,
  saveNpmConnection,
  validateNpmConnection,
  type PublicNpmConnection,
} from "../../models/npm-connection";
import { createScan, listScans, type ScanListItem } from "../../models/scan";
import type { DiffEntry, Finding } from "../../../server/lib/review";
import type { AiFinding } from "../../../server/lib/ai-review";
import type { ScanResult } from "../../../server/types";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyLine,
  Eyebrow,
  Field,
  FindingCard,
  FindingRow,
  Input,
  LoadingLine,
  MonoDetail,
  Muted,
  PageShell,
  SectionLabel,
  SeverityBar,
  severityTone,
  statusTone,
} from "../../components";
import type { SeverityCounts, SeverityKey } from "../../components";

type Status = "idle" | "checking" | "scanning" | "done" | "error";

export default function DashboardPage() {
  const location = useLocation();
  const [session, setSession] = useState<AuthSession | null>(null);
  const [stageId, setStageId] = useState("");
  const [status, setStatus] = useState<Status>("checking");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [scans, setScans] = useState<ScanListItem[]>([]);
  const [npmConnection, setNpmConnection] = useState<PublicNpmConnection | null>(null);
  const [npmToken, setNpmToken] = useState("");
  const [npmLabel, setNpmLabel] = useState("npm registry");
  const [npmRegistry, setNpmRegistry] = useState("https://registry.npmjs.org");
  const [validationStageId, setValidationStageId] = useState("");
  const [connectionStatus, setConnectionStatus] = useState<"idle" | "saving" | "validating" | "deleting">("idle");
  const [connectionError, setConnectionError] = useState<string | null>(null);

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
      await Promise.all([refreshScans(), refreshNpmConnection()]);
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

  async function refreshNpmConnection() {
    try {
      const connection = await getNpmConnection();
      setNpmConnection(connection);
      if (connection) {
        setNpmLabel(connection.label);
        setNpmRegistry(connection.registryUrl);
      }
    } catch {
      // Keep the dashboard usable; scan creation will enforce org npm connection requirements.
    }
  }

  const onSaveNpmConnection = async (event: Event) => {
    event.preventDefault();
    if (!npmToken.trim()) return;
    setConnectionStatus("saving");
    setConnectionError(null);
    try {
      const connection = await saveNpmConnection({
        token: npmToken.trim(),
        label: npmLabel.trim() || "npm registry",
        registryUrl: npmRegistry.trim() || "https://registry.npmjs.org",
      });
      setNpmConnection(connection);
      setNpmToken("");
    } catch (err) {
      setConnectionError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnectionStatus("idle");
    }
  };

  const onValidateNpmConnection = async () => {
    setConnectionStatus("validating");
    setConnectionError(null);
    try {
      const data = await validateNpmConnection(validationStageId);
      setNpmConnection(data.connection);
    } catch (err) {
      setConnectionError(err instanceof Error ? err.message : String(err));
      await refreshNpmConnection();
    } finally {
      setConnectionStatus("idle");
    }
  };

  const onDeleteNpmConnection = async () => {
    setConnectionStatus("deleting");
    setConnectionError(null);
    try {
      await deleteNpmConnection();
      setNpmConnection(null);
      setNpmToken("");
    } catch (err) {
      setConnectionError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnectionStatus("idle");
    }
  };

  const onSubmit = async (event: Event) => {
    event.preventDefault();
    if (!stageId.trim()) return;
    setStatus("scanning");
    setError(null);
    setResult(null);
    try {
      const data = await createScan(stageId.trim());
      setStatus("done");
      await refreshScans();
      location.route(`/dashboard/scans/${encodeURIComponent(data.scan.id)}`);
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
    return (
      <PageShell width="narrow">
        <Card>
          <LoadingLine>Opening workspace</LoadingLine>
        </Card>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <header class="flex flex-wrap gap-4 items-start justify-between">
        <div class="flex flex-col gap-2 max-w-[640px]">
          <Eyebrow>Review workspace</Eyebrow>
          <h1 class="text-3xl font-semibold tracking-[-0.02em] m-0">Ready for the next release</h1>
          <Muted class="text-[14px] leading-[1.55] m-0">
            Bring in a staged npm publish, compare it with the live version, and get a focused safety
            brief before maintainers approve.
          </Muted>
        </div>
        <div class="flex items-center gap-2.5 bg-surface border border-border rounded-lg pl-3.5 pr-1.5 py-1.5">
          <span class="font-mono text-xs text-ink-muted">
            {session?.user.email || session?.user.name || "signed in"}
          </span>
          <Button variant="secondary" size="sm" onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      </header>

      <ReviewRequestCard
        npmConnection={npmConnection}
        status={status}
        stageId={stageId}
        error={error}
        onStageIdChange={setStageId}
        onSubmit={onSubmit}
      />

      {result ? <ScanResultView result={result} /> : null}

      <RecentReviewsSection scans={scans} onRefresh={refreshScans} />

      <WorkspaceSetupPanel
        connection={npmConnection}
        token={npmToken}
        label={npmLabel}
        registry={npmRegistry}
        status={connectionStatus}
        error={connectionError}
        validationStageId={validationStageId}
        onTokenChange={setNpmToken}
        onLabelChange={setNpmLabel}
        onRegistryChange={setNpmRegistry}
        onValidationStageIdChange={setValidationStageId}
        onSave={onSaveNpmConnection}
        onValidate={onValidateNpmConnection}
        onDelete={onDeleteNpmConnection}
      />
    </PageShell>
  );
}

function ReviewRequestCard({
  npmConnection,
  status,
  stageId,
  error,
  onStageIdChange,
  onSubmit,
}: {
  npmConnection: PublicNpmConnection | null;
  status: Status;
  stageId: string;
  error: string | null;
  onStageIdChange: (value: string) => void;
  onSubmit: (event: Event) => void;
}) {
  return (
    <Card class="p-5 md:p-6 flex flex-col gap-4 border-accent/40">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex flex-col gap-1.5">
          <SectionLabel>Request review</SectionLabel>
          <Muted class="text-[13px] max-w-[720px]">
            Paste a staged publish ID. We'll compare it with the latest published release and open the saved report when it is ready.
          </Muted>
        </div>
        <Badge tone={status === "scanning" ? "info" : npmConnection ? "ok" : "info"}>
          {status === "scanning" ? "running" : npmConnection ? "ready" : "setup needed"}
        </Badge>
      </div>
      {!npmConnection ? (
        <Alert tone="info">Connect npm access in workspace setup before reviewing staged packages.</Alert>
      ) : null}
      <form class="flex flex-col gap-3" onSubmit={onSubmit}>
        <Field label="Stage ID" for="stageId">
          <div class="flex flex-col sm:flex-row gap-2">
            <Input
              id="stageId"
              type="text"
              value={stageId}
              placeholder="e.g. acme-pkg-1.2.3-stage-abcdef"
              onInput={(e) => onStageIdChange((e.target as HTMLInputElement).value)}
              disabled={status === "scanning"}
              autoComplete="off"
              spellcheck={false}
            />
            <Button
              type="submit"
              disabled={status === "scanning" || !stageId.trim() || !npmConnection}
              class="shrink-0"
            >
              {status === "scanning" ? "Reviewing…" : "Review staged publish"}
            </Button>
          </div>
        </Field>
      </form>
      {error ? <Alert tone="critical">{error}</Alert> : null}
    </Card>
  );
}

function RecentReviewsSection({ scans, onRefresh }: { scans: ScanListItem[]; onRefresh: () => void }) {
  return (
    <section class="flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <SectionLabel class="flex-1">Recent reviews</SectionLabel>
        <Button variant="secondary" size="sm" onClick={onRefresh} class="ml-3 shrink-0">
          Refresh
        </Button>
      </div>
      <Card class="p-0 overflow-hidden">
        {scans.length ? (
          <ScanTable scans={scans} />
        ) : (
          <div class="p-5">
            <EmptyLine>No reviews yet. Request one above to start building your release history.</EmptyLine>
          </div>
        )}
      </Card>
    </section>
  );
}

function WorkspaceSetupPanel({
  connection,
  token,
  label,
  registry,
  validationStageId,
  status,
  error,
  onTokenChange,
  onLabelChange,
  onRegistryChange,
  onValidationStageIdChange,
  onSave,
  onValidate,
  onDelete,
}: {
  connection: PublicNpmConnection | null;
  token: string;
  label: string;
  registry: string;
  validationStageId: string;
  status: "idle" | "saving" | "validating" | "deleting";
  error: string | null;
  onTokenChange: (value: string) => void;
  onLabelChange: (value: string) => void;
  onRegistryChange: (value: string) => void;
  onValidationStageIdChange: (value: string) => void;
  onSave: (event: Event) => void;
  onValidate: () => void;
  onDelete: () => void;
}) {
  return (
    <details open={!connection} class="group">
      <summary class="list-none cursor-pointer rounded-lg border border-border bg-surface px-4 py-3 transition-colors duration-150 ease-out hover:border-border-strong hover:bg-surface-2">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex flex-col gap-1.5 min-w-0">
            <SectionLabel>Workspace setup</SectionLabel>
            <Muted class="text-[13px] m-0">
              Manage npm access, credential checks, and workspace safety defaults.
            </Muted>
            <MonoDetail
              parts={[
                <span>npm {connection ? "connected" : "not connected"}</span>,
                <span>redacted evidence</span>,
                <span>human approval</span>,
              ]}
            />
          </div>
          <div class="flex flex-wrap items-center justify-end gap-2">
            <Badge tone={connection ? "ok" : "info"}>{connection ? connection.validationStatus : "connect npm"}</Badge>
            <span class="inline-flex items-center justify-center rounded-md border border-border bg-surface-2 px-3 py-1.5 text-[12px] font-medium text-ink group-open:hidden">
              Open settings
            </span>
            <span class="hidden items-center justify-center rounded-md border border-border bg-surface-2 px-3 py-1.5 text-[12px] font-medium text-ink group-open:inline-flex">
              Hide settings
            </span>
          </div>
        </div>
      </summary>
      <div class="pt-3">
        <NpmConnectionCard
          connection={connection}
          token={token}
          label={label}
          registry={registry}
          status={status}
          error={error}
          validationStageId={validationStageId}
          onTokenChange={onTokenChange}
          onLabelChange={onLabelChange}
          onRegistryChange={onRegistryChange}
          onValidationStageIdChange={onValidationStageIdChange}
          onSave={onSave}
          onValidate={onValidate}
          onDelete={onDelete}
        />
      </div>
    </details>
  );
}

function NpmConnectionCard({
  connection,
  token,
  label,
  registry,
  validationStageId,
  status,
  error,
  onTokenChange,
  onLabelChange,
  onRegistryChange,
  onValidationStageIdChange,
  onSave,
  onValidate,
  onDelete,
}: {
  connection: PublicNpmConnection | null;
  token: string;
  label: string;
  registry: string;
  validationStageId: string;
  status: "idle" | "saving" | "validating" | "deleting";
  error: string | null;
  onTokenChange: (value: string) => void;
  onLabelChange: (value: string) => void;
  onRegistryChange: (value: string) => void;
  onValidationStageIdChange: (value: string) => void;
  onSave: (event: Event) => void;
  onValidate: () => void;
  onDelete: () => void;
}) {
  const busy = status !== "idle";
  const validated = connection?.validationStatus === "valid";

  return (
    <Card class="p-5 flex flex-col gap-4">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex flex-col gap-1.5">
          <SectionLabel>npm access</SectionLabel>
          <Muted class="text-[13px] max-w-[760px]">
            Add an organization npm token so reviews can fetch staged packages securely. We encrypt it,
            hide it after save, and use it only to retrieve release evidence.
          </Muted>
        </div>
        {connection ? (
          <Badge tone={validated ? "ok" : connection.validationStatus === "invalid" ? "critical" : "info"}>
            {connection.validationStatus}
          </Badge>
        ) : (
          <Badge tone="info">not connected</Badge>
        )}
      </div>

      {connection ? (
        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-x-6 gap-y-2 border-y border-border py-3">
          <CompactMetadataRow label="label" value={connection.label} />
          <CompactMetadataRow label="registry" value={connection.registryUrl} />
          <CompactMetadataRow label="token" value={`•••• ${connection.tokenLast4 || "stored"}`} />
          <CompactMetadataRow label="validated" value={connection.validatedAt ? formatDate(connection.validatedAt) : "not yet"} />
          <CompactMetadataRow label="last used" value={connection.lastUsedAt ? formatDate(connection.lastUsedAt) : "never"} />
        </div>
      ) : null}

      <form class="grid grid-cols-1 lg:grid-cols-[1fr_1fr_1.5fr_auto] gap-3 items-end" onSubmit={onSave}>
        <Field label="Connection name" for="npmLabel">
          <Input
            id="npmLabel"
            type="text"
            value={label}
            onInput={(e) => onLabelChange((e.target as HTMLInputElement).value)}
            disabled={busy}
          />
        </Field>
        <Field label="Registry" for="npmRegistry">
          <Input
            id="npmRegistry"
            type="url"
            value={registry}
            onInput={(e) => onRegistryChange((e.target as HTMLInputElement).value)}
            disabled={busy}
          />
        </Field>
        <Field label={connection ? "New npm token" : "npm token"} for="npmToken">
          <Input
            id="npmToken"
            type="password"
            value={token}
            placeholder={connection ? "Paste a new token to rotate" : "npm_..."}
            onInput={(e) => onTokenChange((e.target as HTMLInputElement).value)}
            disabled={busy}
            autoComplete="off"
            spellcheck={false}
          />
        </Field>
        <Button type="submit" disabled={busy || !token.trim()} class="shrink-0">
          {status === "saving" ? "Saving…" : connection ? "Rotate" : "Save"}
        </Button>
      </form>

      <div class="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto_auto] gap-2 items-end">
        <Field label="Stage ID access check" for="validationStageId">
          <Input
            id="validationStageId"
            type="text"
            value={validationStageId}
            placeholder="Paste a real stage ID to confirm package access"
            onInput={(e) => onValidationStageIdChange((e.target as HTMLInputElement).value)}
            disabled={busy || !connection}
            autoComplete="off"
            spellcheck={false}
          />
        </Field>
        <Button variant="secondary" size="sm" onClick={onValidate} disabled={busy || !connection}>
          {status === "validating" ? "Checking…" : validationStageId.trim() ? "Check stage access" : "Check npm auth"}
        </Button>
        <Button variant="danger" size="sm" onClick={onDelete} disabled={busy || !connection}>
          {status === "deleting" ? "Removing…" : "Disconnect"}
        </Button>
      </div>

      <Muted class="text-xs">
        Without a stage ID, we confirm the token is accepted by npm. Add a stage ID to prove it can read that staged release; we do not keep the release archive.
      </Muted>

      {error ? <Alert tone="critical">{error}</Alert> : null}
    </Card>
  );
}

function CompactMetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div class="grid grid-cols-[92px_minmax(0,1fr)] gap-3 text-[13px] min-w-0">
      <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">{label}</span>
      <code class="text-xs text-ink-muted break-all">{value}</code>
    </div>
  );
}

function ScanResultView({ result }: { result: ScanResult }) {
  const ai = result.aiFindings;
  const changed = result.diff.filter((entry) => entry.status !== "unchanged");
  const severityCounts = countSeverities([...result.ruleFindings, ...ai.findings]);
  const findingTotal = Object.values(severityCounts).reduce((sum, count) => sum + (count ?? 0), 0);

  return (
    <section class="flex flex-col gap-5">
      <SectionLabel>Review result</SectionLabel>

      <div class="flex flex-col gap-3 border-y border-border py-4">
        <div class="flex flex-wrap items-center gap-2">
          <Badge tone={severityTone(result.risk)}>{result.risk}</Badge>
          <Badge tone={ai.requiresManualReview ? "medium" : "ok"}>
            {ai.requiresManualReview ? "manual review" : "no extra review"}
          </Badge>
          <Badge tone={findingTotal ? "medium" : "ok"}>
            {findingTotal ? `${findingTotal} ${pluralize("finding", findingTotal)}` : "no findings"}
          </Badge>
          <Badge tone="neutral">{ai.releaseAssessment.replaceAll("_", " ")}</Badge>
        </div>
        <MonoDetail
          parts={[
            result.package.name || "unknown package",
            <span>{result.package.previousVersion || "—"} → {result.package.stagedVersion || "—"}</span>,
            <span>{result.fileCount} {pluralize("file", result.fileCount)}</span>,
            <span>{changed.length} changed</span>,
          ]}
        />
        {findingTotal ? <SeverityBar counts={severityCounts} class="max-w-[520px]" /> : null}
      </div>

      {ai.summary ? (
        <div class="bg-surface border border-border border-l-[3px] border-l-accent rounded-lg px-4 py-3 text-[13px] leading-[1.55]">
          {ai.summary}
        </div>
      ) : null}

      <ResultSection title={`Rule findings (${result.ruleFindings.length})`}>
        <RuleFindingList findings={result.ruleFindings} />
      </ResultSection>

      <ResultSection title={`Assistant findings (${ai.findings.length})`}>
        <AiFindingList findings={ai.findings} />
      </ResultSection>

      <ResultSection title={`Release changes (${changed.length})`}>
        <DiffList entries={changed} />
      </ResultSection>

      <Card as="div" class="p-0">
        <details class="group">
          <summary class="cursor-pointer text-[13px] text-ink-muted px-4 py-3 list-none">
            Safety model
          </summary>
          <pre class="bg-surface-2 rounded-lg mx-4 mb-4 p-3 overflow-x-auto text-xs leading-[1.5]">
            {JSON.stringify(result.safety, null, 2)}
          </pre>
        </details>
      </Card>
    </section>
  );
}

function countSeverities(findings: Array<{ severity?: string }>): SeverityCounts {
  const counts: SeverityCounts = {};
  for (const finding of findings) {
    const key = normalizeSeverityKey(finding.severity);
    if (!key) continue;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function normalizeSeverityKey(value: string | undefined): SeverityKey | null {
  switch (value) {
    case "critical":
    case "high":
    case "medium":
    case "low":
    case "info":
    case "ok":
      return value;
    default:
      return null;
  }
}

function ResultSection({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <section class="flex flex-col gap-3">
      <h2 class="text-[13px] font-medium uppercase tracking-[0.08em] text-ink-muted m-0">{title}</h2>
      {children}
    </section>
  );
}

function ScanTable({ scans }: { scans: ScanListItem[] }) {
  return (
    <div class="overflow-x-auto">
      <table class="w-full border-collapse text-[13px]">
        <thead>
          <tr class="border-b border-border bg-surface-2">
            <Th>Package</Th>
            <Th>Version</Th>
            <Th>Risk</Th>
            <Th>Status</Th>
            <Th>Created</Th>
          </tr>
        </thead>
        <tbody>
          {scans.map((scan) => (
            <tr key={scan.id} class="border-b border-border last:border-b-0 hover:bg-surface-2">
              <Td>
                <a href={`/dashboard/scans/${encodeURIComponent(scan.id)}`}>
                  {scan.packageName || scan.stageId}
                </a>
              </Td>
              <Td class="font-mono text-xs text-ink-muted">
                {scan.previousVersion || "—"} → {scan.stagedVersion || "—"}
              </Td>
              <Td>
                <Badge tone={severityTone(scan.risk)}>{scan.risk}</Badge>
              </Td>
              <Td class="font-mono text-xs text-ink-muted">{scan.status}</Td>
              <Td class="font-mono text-xs text-ink-muted">{formatDate(scan.createdAt)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children }: { children: ComponentChildren }) {
  return (
    <th class="text-left font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle px-4 py-2.5">
      {children}
    </th>
  );
}

function Td({ children, class: className }: { children: ComponentChildren; class?: string }) {
  return <td class={`px-4 py-2.5 align-middle ${className || ""}`}>{children}</td>;
}

function RuleFindingList({ findings }: { findings: Finding[] }) {
  if (!findings.length) return <EmptyLine>No rule findings.</EmptyLine>;
  return (
    <ul class="list-none p-0 m-0 flex flex-col gap-2">
      {findings.map((f, i) => (
        <FindingCard key={`${f.file}-${i}`} severity={f.severity} file={f.file}>
          <FindingRow label="evidence" value={f.evidence} />
          <FindingRow label="reason" value={f.reason} />
        </FindingCard>
      ))}
    </ul>
  );
}

function AiFindingList({ findings }: { findings: AiFinding[] }) {
  if (!findings.length) return <EmptyLine>No assistant findings.</EmptyLine>;
  return (
    <ul class="list-none p-0 m-0 flex flex-col gap-2">
      {findings.map((f, i) => (
        <FindingCard key={`${f.file}-${i}`} severity={f.severity} file={f.file}>
          <FindingRow label="evidence" value={f.evidence} />
          <FindingRow label="reason" value={f.reason} />
          <FindingRow label="recommendation" value={f.recommendation} />
        </FindingCard>
      ))}
    </ul>
  );
}

function DiffList({ entries }: { entries: DiffEntry[] }) {
  if (!entries.length) return <EmptyLine>No changes detected.</EmptyLine>;
  return (
    <ul class="list-none p-0 m-0 flex flex-col gap-1">
      {entries.map((entry) => (
        <li
          key={entry.path}
          class="grid grid-cols-[auto_1fr_auto] gap-3 items-center bg-surface border border-border rounded-lg px-3 py-2 text-[13px] font-mono"
        >
          <Badge tone={statusTone(entry.status)}>{entry.status}</Badge>
          <span class="truncate">{entry.path}</span>
          <span class="text-ink-subtle text-xs">
            {entry.previousSize ?? 0} → {entry.stagedSize ?? 0} B
          </span>
        </li>
      ))}
    </ul>
  );
}

function pluralize(word: string, count: number) {
  return count === 1 ? word : `${word}s`;
}

function formatDate(value: ScanListItem["createdAt"]) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}
