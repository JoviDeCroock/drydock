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
import { listScans, runScan, type ScanListItem } from "../../models/scan";
import type { DiffEntry, Finding } from "../../../server/lib/review";
import type { AiFinding } from "../../../server/lib/ai-review";
import type { ScanResult } from "../../../server/types";
import {
  Alert,
  Badge,
  Button,
  Card,
  Eyebrow,
  Field,
  Input,
  Muted,
  PageShell,
  SectionLabel,
  SummaryCard,
  severityTone,
  statusTone,
} from "../../components";

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
      // A local fallback NPM_TOKEN may still make scans usable.
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
    return (
      <PageShell width="narrow">
        <Card>
          <Muted>Checking session…</Muted>
        </Card>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <header class="flex flex-wrap gap-4 items-start justify-between">
        <div class="flex flex-col gap-2 max-w-[640px]">
          <Eyebrow>Authenticated dashboard</Eyebrow>
          <h1 class="text-3xl font-semibold tracking-[-0.02em] m-0">Staged Publish Review</h1>
          <Muted class="text-[14px] leading-[1.55] m-0">
            Review npm staged packages through a sandboxed Dynamic Worker, deterministic release checks,
            previous-version diffs, and Kimi K2.5 triage.
          </Muted>
        </div>
        <div class="flex items-center gap-2.5 bg-surface border border-border rounded-full pl-3.5 pr-1.5 py-1.5">
          <span class="font-mono text-xs text-ink-muted">
            {session?.user.email || session?.user.name || "signed in"}
          </span>
          <Button variant="secondary" size="sm" onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      </header>

      <LaunchGuardrailStrip hasNpmConnection={Boolean(npmConnection)} />

      <NpmConnectionCard
        connection={npmConnection}
        token={npmToken}
        label={npmLabel}
        registry={npmRegistry}
        status={connectionStatus}
        error={connectionError}
        onTokenChange={setNpmToken}
        onLabelChange={setNpmLabel}
        validationStageId={validationStageId}
        onRegistryChange={setNpmRegistry}
        onValidationStageIdChange={setValidationStageId}
        onSave={onSaveNpmConnection}
        onValidate={onValidateNpmConnection}
        onDelete={onDeleteNpmConnection}
      />

      <Card class="p-5 flex flex-col gap-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="flex flex-col gap-1.5">
            <SectionLabel>Run review</SectionLabel>
            <Muted class="text-[13px] max-w-[720px]">
              Paste a stage ID from npm staged publish. The scan downloads evidence through the gateway, compares against the previous published version, and persists a redacted report.
            </Muted>
          </div>
          <Badge tone={status === "scanning" ? "info" : "ok"}>{status === "scanning" ? "running" : "ready"}</Badge>
        </div>
        {!npmConnection ? (
          <Alert tone="info">Connect an organization npm token first for production SaaS scans. Local/dev deployments may still use the fallback worker secret.</Alert>
        ) : null}
        <form class="flex flex-col gap-3" onSubmit={onSubmit}>
          <Field label="Stage ID" for="stageId">
            <div class="flex flex-col sm:flex-row gap-2">
              <Input
                id="stageId"
                type="text"
                value={stageId}
                placeholder="e.g. acme-pkg-1.2.3-stage-abcdef"
                onInput={(e) => setStageId((e.target as HTMLInputElement).value)}
                disabled={status === "scanning"}
                autoComplete="off"
                spellcheck={false}
              />
              <Button
                type="submit"
                disabled={status === "scanning" || !stageId.trim()}
                class="shrink-0"
              >
                {status === "scanning" ? "Scanning…" : "Scan staged publish"}
              </Button>
            </div>
          </Field>
        </form>
        {error ? (
          <div class="mt-3">
            <Alert tone="critical">{error}</Alert>
          </div>
        ) : null}
      </Card>

      {result ? <ScanResultView result={result} /> : null}

      <section class="flex flex-col gap-3">
        <div class="flex items-center justify-between">
          <SectionLabel class="flex-1">Recent scans</SectionLabel>
          <Button variant="secondary" size="sm" onClick={refreshScans} class="ml-3 shrink-0">
            Refresh
          </Button>
        </div>
        <Card class="p-0 overflow-hidden">
          {scans.length ? (
            <ScanTable scans={scans} />
          ) : (
            <div class="p-5">
              <Muted>No persisted scans yet.</Muted>
            </div>
          )}
        </Card>
      </section>
    </PageShell>
  );
}

function LaunchGuardrailStrip({ hasNpmConnection }: { hasNpmConnection: boolean }) {
  return (
    <section class="grid grid-cols-1 md:grid-cols-3 gap-3">
      <GuardrailCard
        label="Credential boundary"
        status={hasNpmConnection ? "configured" : "setup needed"}
        tone={hasNpmConnection ? "ok" : "info"}
      >
        npm auth is injected by the outbound Worker, never inside the sandbox.
      </GuardrailCard>
      <GuardrailCard label="Artifact retention" status="safe default" tone="ok">
        Raw tarballs are not retained; reports store bounded redacted evidence.
      </GuardrailCard>
      <GuardrailCard label="Approval model" status="manual" tone="neutral">
        Maintainers still approve in npm with their normal 2FA-protected workflow.
      </GuardrailCard>
    </section>
  );
}

function GuardrailCard({
  label,
  status,
  tone,
  children,
}: {
  label: string;
  status: string;
  tone: "ok" | "info" | "neutral";
  children: ComponentChildren;
}) {
  return (
    <Card class="p-4 flex flex-col gap-2 min-h-[118px]">
      <div class="flex items-center justify-between gap-3">
        <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">{label}</span>
        <Badge tone={tone}>{status}</Badge>
      </div>
      <p class="m-0 text-[13px] leading-[1.55] text-ink-muted">{children}</p>
    </Card>
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
          <SectionLabel>npm connection</SectionLabel>
          <Muted class="text-[13px] max-w-[760px]">
            Store an organization-scoped npm token for staged-package downloads. The token is encrypted,
            never shown again, and injected only by the outbound gateway outside the sandbox.
          </Muted>
        </div>
        {connection ? (
          <Badge tone={validated ? "ok" : connection.validationStatus === "invalid" ? "critical" : "info"}>
            {connection.validationStatus}
          </Badge>
        ) : (
          <Badge tone="info">not configured</Badge>
        )}
      </div>

      {connection ? (
        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
          <SummaryCard label="label">{connection.label}</SummaryCard>
          <SummaryCard label="registry">{connection.registryUrl}</SummaryCard>
          <SummaryCard label="token">•••• {connection.tokenLast4 || "stored"}</SummaryCard>
          <SummaryCard label="validated">{connection.validatedAt ? formatDate(connection.validatedAt) : "not yet"}</SummaryCard>
          <SummaryCard label="last used">{connection.lastUsedAt ? formatDate(connection.lastUsedAt) : "never"}</SummaryCard>
        </div>
      ) : null}

      <form class="grid grid-cols-1 lg:grid-cols-[1fr_1fr_1.5fr_auto] gap-3 items-end" onSubmit={onSave}>
        <Field label="Label" for="npmLabel">
          <Input
            id="npmLabel"
            type="text"
            value={label}
            onInput={(e) => onLabelChange((e.target as HTMLInputElement).value)}
            disabled={busy}
          />
        </Field>
        <Field label="Registry URL" for="npmRegistry">
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
            placeholder={connection ? "Paste to rotate token" : "npm_..."}
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
        <Field label="Optional stage ID validation" for="validationStageId">
          <Input
            id="validationStageId"
            type="text"
            value={validationStageId}
            placeholder="Check staged tarball access for a real stage ID"
            onInput={(e) => onValidationStageIdChange((e.target as HTMLInputElement).value)}
            disabled={busy || !connection}
            autoComplete="off"
            spellcheck={false}
          />
        </Field>
        <Button variant="secondary" size="sm" onClick={onValidate} disabled={busy || !connection}>
          {status === "validating" ? "Validating…" : validationStageId.trim() ? "Validate stage access" : "Validate auth"}
        </Button>
        <Button variant="danger" size="sm" onClick={onDelete} disabled={busy || !connection}>
          {status === "deleting" ? "Removing…" : "Remove connection"}
        </Button>
      </div>

      <Muted class="text-xs">
        Without a stage ID, validation checks npm registry auth. With a stage ID, it also verifies staged-tarball access without retaining the tarball.
      </Muted>

      {error ? <Alert tone="critical">{error}</Alert> : null}
    </Card>
  );
}

function ScanResultView({ result }: { result: ScanResult }) {
  const ai = result.aiFindings;
  const changed = result.diff.filter((entry) => entry.status !== "unchanged");
  const riskTone = result.risk === "high" || result.risk === "critical" ? "danger" : "default";

  return (
    <section class="flex flex-col gap-5">
      <SectionLabel>Scan result</SectionLabel>

      <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <SummaryCard label="package">{result.package.name || "unknown"}</SummaryCard>
        <SummaryCard label="version">
          {result.package.previousVersion || "—"} → {result.package.stagedVersion || "—"}
        </SummaryCard>
        <SummaryCard label="risk" tone={riskTone}>
          {result.risk}
        </SummaryCard>
        <SummaryCard label="files">
          {result.fileCount} ({changed.length} changed)
        </SummaryCard>
        <SummaryCard label="AI assessment">{ai.releaseAssessment.replaceAll("_", " ")}</SummaryCard>
        <SummaryCard label="manual review">{ai.requiresManualReview ? "yes" : "no"}</SummaryCard>
      </div>

      {ai.summary ? (
        <div class="bg-surface border-l-[3px] border-accent rounded-md px-4 py-3 leading-[1.55]">
          {ai.summary}
        </div>
      ) : null}

      <ResultSection title={`Deterministic findings (${result.ruleFindings.length})`}>
        <RuleFindingList findings={result.ruleFindings} />
      </ResultSection>

      <ResultSection title={`AI findings (${ai.findings.length})`}>
        <AiFindingList findings={ai.findings} />
      </ResultSection>

      <ResultSection title={`Changed files (${changed.length})`}>
        <DiffList entries={changed} />
      </ResultSection>

      <Card as="div" class="p-0">
        <details class="group">
          <summary class="cursor-pointer text-[13px] text-ink-muted px-4 py-3 list-none">
            Safety posture
          </summary>
          <pre class="bg-surface-2 rounded-md mx-4 mb-4 p-3 overflow-x-auto text-xs leading-[1.5]">
            {JSON.stringify(result.safety, null, 2)}
          </pre>
        </details>
      </Card>
    </section>
  );
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
  if (!findings.length) return <Muted class="text-[13px]">No deterministic findings.</Muted>;
  return (
    <ul class="list-none p-0 m-0 flex flex-col gap-2">
      {findings.map((f, i) => (
        <FindingItem key={`${f.file}-${i}`} severity={f.severity} file={f.file}>
          <FindingRow label="evidence" value={f.evidence} />
          <FindingRow label="reason" value={f.reason} />
        </FindingItem>
      ))}
    </ul>
  );
}

function AiFindingList({ findings }: { findings: AiFinding[] }) {
  if (!findings.length) return <Muted class="text-[13px]">No AI findings.</Muted>;
  return (
    <ul class="list-none p-0 m-0 flex flex-col gap-2">
      {findings.map((f, i) => (
        <FindingItem key={`${f.file}-${i}`} severity={f.severity} file={f.file}>
          <FindingRow label="evidence" value={f.evidence} />
          <FindingRow label="reason" value={f.reason} />
          <FindingRow label="recommendation" value={f.recommendation} />
        </FindingItem>
      ))}
    </ul>
  );
}

export function FindingItem({
  severity,
  file,
  children,
}: {
  severity: string;
  file: string;
  children: ComponentChildren;
}) {
  return (
    <li class="bg-surface border border-border rounded-md px-4 py-3 flex flex-col gap-2">
      <div class="flex items-center gap-2.5">
        <Badge tone={severityTone(severity)} dot>
          {severity}
        </Badge>
        <code class="text-[13px] text-ink-muted">{file}</code>
      </div>
      <div class="text-[13px] leading-[1.55] flex flex-col gap-0.5">{children}</div>
    </li>
  );
}

export function FindingRow({ label, value }: { label: string; value: ComponentChildren }) {
  return (
    <div>
      <span class="text-ink-subtle font-mono text-[11px] uppercase tracking-[0.08em] mr-1.5">
        {label}:
      </span>
      <span>{value}</span>
    </div>
  );
}

function DiffList({ entries }: { entries: DiffEntry[] }) {
  if (!entries.length) return <Muted class="text-[13px]">No changes detected.</Muted>;
  return (
    <ul class="list-none p-0 m-0 flex flex-col gap-1">
      {entries.map((entry) => (
        <li
          key={entry.path}
          class="grid grid-cols-[auto_1fr_auto] gap-3 items-center bg-surface border border-border rounded-md px-3 py-2 text-[13px] font-mono"
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

function formatDate(value: ScanListItem["createdAt"]) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}
