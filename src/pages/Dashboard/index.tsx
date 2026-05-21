import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { useSignal, useModel, useSignalEffect } from "@preact/signals";
import { useLocation } from "preact-iso";
import { sessionModel } from "../../models/auth";
import { NpmConnectionModel } from "../../models/npm-connection";
import { ScanListModel, ScanRequestModel, type ScanListItem } from "../../models/scan";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyLine,
  Eyebrow,
  Field,
  Input,
  LoadingLine,
  MonoDetail,
  Muted,
  PageShell,
  SectionLabel,
  severityTone,
} from "../../components";

export default function DashboardPage() {
  const location = useLocation();
  const scans = useModel(ScanListModel);
  const npm = useModel(NpmConnectionModel);
  const request = useModel(ScanRequestModel);
  const sessionChecked = useSignal(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const data = await sessionModel.load();
      if (cancelled) return;
      if (!data) {
        location.route("/login", true);
        return;
      }
      sessionChecked.value = true;
      await Promise.all([scans.refresh(), npm.load()]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useSignalEffect(() => {
    if (request.status.value !== "done") return;
    const id = request.lastResult.value?.scan.id;
    if (!id) return;
    void scans.refresh();
    location.route(`/dashboard/scans/${encodeURIComponent(id)}`);
  });

  const onSubmit = async (event: Event) => {
    event.preventDefault();
    await request.submit();
  };

  const onSignOut = async () => {
    await sessionModel.signOut();
    location.route("/", true);
  };

  if (!sessionChecked.value) {
    return (
      <PageShell width="narrow">
        <Card>
          <LoadingLine>Opening workspace</LoadingLine>
        </Card>
      </PageShell>
    );
  }

  const user = sessionModel.user.value;

  return (
    <PageShell>
      <header class="flex flex-wrap gap-4 items-start justify-between">
        <div class="flex flex-col gap-2 max-w-[640px]">
          <Eyebrow>Review workspace</Eyebrow>
          <h1 class="text-3xl font-semibold tracking-[-0.02em] m-0">Ready for the next release</h1>
          <Muted class="text-[14px] leading-[1.55] m-0">
            Bring in a staged npm publish, compare it with the live version, and get a focused
            safety brief before maintainers approve.
          </Muted>
        </div>
        <div class="flex items-center gap-2.5 bg-surface border border-border rounded-lg pl-3.5 pr-1.5 py-1.5">
          <span class="font-mono text-xs text-ink-muted">
            {user?.email || user?.name || "signed in"}
          </span>
          <Button variant="secondary" size="sm" onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      </header>

      <ReviewRequestCard npm={npm} request={request} onSubmit={onSubmit} />

      <RecentReviewsSection scans={scans} />

      <WorkspaceSetupPanel npm={npm} />
    </PageShell>
  );
}

function ReviewRequestCard({
  npm,
  request,
  onSubmit,
}: {
  npm: ReturnType<typeof useModel<typeof NpmConnectionModel.prototype>>;
  request: ReturnType<typeof useModel<typeof ScanRequestModel.prototype>>;
  onSubmit: (event: Event) => void;
}) {
  const status = request.status.value;
  const stageId = request.stageId.value;
  const hasConnection = npm.isConnected.value;

  return (
    <Card class="p-5 md:p-6 flex flex-col gap-4 border-accent/40">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex flex-col gap-1.5">
          <SectionLabel>Request review</SectionLabel>
          <Muted class="text-[13px] max-w-[720px]">
            Paste a staged publish ID. We'll compare it with the latest published release and open
            the saved report when it is ready.
          </Muted>
        </div>
        <Badge tone={status === "scanning" ? "info" : hasConnection ? "ok" : "info"}>
          {status === "scanning" ? "running" : hasConnection ? "ready" : "setup needed"}
        </Badge>
      </div>
      {!hasConnection ? (
        <Alert tone="info">
          Connect npm access in workspace setup before reviewing staged packages.
        </Alert>
      ) : null}
      <form class="flex flex-col gap-3" onSubmit={onSubmit}>
        <Field label="Stage ID" for="stageId">
          <div class="flex flex-col sm:flex-row gap-2">
            <Input
              id="stageId"
              type="text"
              value={stageId}
              placeholder="e.g. acme-pkg-1.2.3-stage-abcdef"
              onInput={(e) => (request.stageId.value = (e.target as HTMLInputElement).value)}
              disabled={status === "scanning"}
              autoComplete="off"
              spellcheck={false}
            />
            <Button
              type="submit"
              disabled={status === "scanning" || !stageId.trim() || !hasConnection}
              class="shrink-0"
            >
              {status === "scanning" ? "Reviewing…" : "Review staged publish"}
            </Button>
          </div>
        </Field>
      </form>
      {request.error.value ? <Alert tone="critical">{request.error.value}</Alert> : null}
    </Card>
  );
}

function RecentReviewsSection({
  scans,
}: {
  scans: ReturnType<typeof useModel<typeof ScanListModel.prototype>>;
}) {
  return (
    <section class="flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <SectionLabel class="flex-1">Recent reviews</SectionLabel>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void scans.refresh()}
          class="ml-3 shrink-0"
          disabled={scans.refreshing.value}
        >
          {scans.refreshing.value ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      <Card class="p-0 overflow-hidden">
        {scans.scans.value.length ? (
          <ScanTable scans={scans.scans.value} />
        ) : (
          <div class="p-5">
            <EmptyLine>
              No reviews yet. Request one above to start building your release history.
            </EmptyLine>
          </div>
        )}
      </Card>
    </section>
  );
}

function WorkspaceSetupPanel({
  npm,
}: {
  npm: ReturnType<typeof useModel<typeof NpmConnectionModel.prototype>>;
}) {
  const connection = npm.connection.value;
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
                <span key="connection">npm {connection ? "connected" : "not connected"}</span>,
                <span key="evidence">redacted evidence</span>,
                <span key="approval">human approval</span>,
              ]}
            />
          </div>
          <div class="flex flex-wrap items-center justify-end gap-2">
            <Badge tone={connection ? "ok" : "info"}>
              {connection ? connection.validationStatus : "connect npm"}
            </Badge>
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
        <NpmConnectionCard npm={npm} />
      </div>
    </details>
  );
}

function NpmConnectionCard({
  npm,
}: {
  npm: ReturnType<typeof useModel<typeof NpmConnectionModel.prototype>>;
}) {
  const connection = npm.connection.value;
  const status = npm.status.value;
  const busy = npm.busy.value;
  const validated = npm.validated.value;
  const token = npm.token.value;
  const label = npm.label.value;
  const registry = npm.registry.value;
  const validationStageId = npm.validationStageId.value;
  const error = npm.error.value;

  const onSave = async (event: Event) => {
    event.preventDefault();
    await npm.save();
  };

  return (
    <Card class="p-5 flex flex-col gap-4">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex flex-col gap-1.5">
          <SectionLabel>npm access</SectionLabel>
          <Muted class="text-[13px] max-w-[760px]">
            Add an organization npm token so reviews can fetch staged packages securely. We encrypt
            it, hide it after save, and use it only to retrieve release evidence.
          </Muted>
        </div>
        {connection ? (
          <Badge
            tone={
              validated ? "ok" : connection.validationStatus === "invalid" ? "critical" : "info"
            }
          >
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
          <CompactMetadataRow
            label="validated"
            value={connection.validatedAt ? formatDate(connection.validatedAt) : "not yet"}
          />
          <CompactMetadataRow
            label="last used"
            value={connection.lastUsedAt ? formatDate(connection.lastUsedAt) : "never"}
          />
        </div>
      ) : null}

      <form
        class="grid grid-cols-1 lg:grid-cols-[1fr_1fr_1.5fr_auto] gap-3 items-end"
        onSubmit={onSave}
      >
        <Field label="Connection name" for="npmLabel">
          <Input
            id="npmLabel"
            type="text"
            value={label}
            onInput={(e) => (npm.label.value = (e.target as HTMLInputElement).value)}
            disabled={busy}
          />
        </Field>
        <Field label="Registry" for="npmRegistry">
          <Input
            id="npmRegistry"
            type="url"
            value={registry}
            onInput={(e) => (npm.registry.value = (e.target as HTMLInputElement).value)}
            disabled={busy}
          />
        </Field>
        <Field label={connection ? "New npm token" : "npm token"} for="npmToken">
          <Input
            id="npmToken"
            type="password"
            value={token}
            placeholder={connection ? "Paste a new token to rotate" : "npm_..."}
            onInput={(e) => (npm.token.value = (e.target as HTMLInputElement).value)}
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
            onInput={(e) => (npm.validationStageId.value = (e.target as HTMLInputElement).value)}
            disabled={busy || !connection}
            autoComplete="off"
            spellcheck={false}
          />
        </Field>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void npm.validate()}
          disabled={busy || !connection}
        >
          {status === "validating"
            ? "Checking…"
            : validationStageId.trim()
              ? "Check stage access"
              : "Check npm auth"}
        </Button>
        <Button
          variant="danger"
          size="sm"
          onClick={() => void npm.remove()}
          disabled={busy || !connection}
        >
          {status === "deleting" ? "Removing…" : "Disconnect"}
        </Button>
      </div>

      <Muted class="text-xs">
        Without a stage ID, we confirm the token is accepted by npm. Add a stage ID to prove it can
        read that staged release; we do not keep the release archive.
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

function formatDate(value: ScanListItem["createdAt"]) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}
