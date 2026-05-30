import { useEffect } from "preact/hooks";
import { useSignal } from "@preact/signals";
import type { DecisionStatus } from "../../../models/scan";
import type { PublicWorkflowGate, WorkflowGateDecision } from "../../../models/github-app";
import {
  Alert,
  Badge,
  Button,
  Dialog,
  Field,
  Input,
  LoadingLine,
  MonoDetail,
  Muted,
  SectionLabel,
} from "../../../components";

export function gateStatusTone(status: PublicWorkflowGate["status"]) {
  switch (status) {
    case "approved":
      return "ok" as const;
    case "rejected":
    case "errored":
      return "critical" as const;
    default:
      return "medium" as const;
  }
}

export function gateStatusLabel(status: PublicWorkflowGate["status"]): string {
  switch (status) {
    case "approved":
      return "approved · job released";
    case "rejected":
      return "rejected · job blocked";
    case "errored":
      return "review errored";
    default:
      return "awaiting decision";
  }
}

export function GateContextPanel({
  gate,
  packageName,
}: {
  gate: PublicWorkflowGate | null;
  packageName: string | null;
}) {
  return (
    <section class="flex flex-col gap-3 border border-border rounded-lg p-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel>Deployment gate</SectionLabel>
        {gate ? (
          <Badge tone={gateStatusTone(gate.status)}>{gateStatusLabel(gate.status)}</Badge>
        ) : null}
      </div>
      <p class="m-0 max-w-[760px] text-[14px] leading-[1.55] text-ink-muted">
        GitHub Actions is holding the publish job
        {packageName ? (
          <>
            {" "}
            for <code>{packageName}</code>
          </>
        ) : null}
        . Drydock reviewed the release candidate it built — approving releases the held job and
        publishing proceeds through PyPI Trusted Publishing (OIDC). Drydock never holds PyPI
        credentials and never uploads the package itself.
      </p>
      {gate ? (
        <MonoDetail
          parts={[
            <span key="repo">{gate.repositoryFullName}</span>,
            <span key="env">env {gate.environment}</span>,
            <span key="run">run #{gate.runId}</span>,
          ]}
        />
      ) : (
        <LoadingLine size="inline">Loading gate context</LoadingLine>
      )}
      {gate?.failureReason ? (
        <Alert tone="critical">
          Drydock blocked this release automatically — the published artifacts could not be verified
          against the reviewed manifest ({gate.failureReason}).
        </Alert>
      ) : null}
    </section>
  );
}

export function GateDecisionDialog({
  open,
  onClose,
  gate,
  packageName,
  status,
  error,
  canApprove,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  gate: PublicWorkflowGate;
  packageName: string | null;
  status: DecisionStatus;
  error: string | null;
  canApprove: boolean;
  onSubmit: (decision: WorkflowGateDecision, comment: string | null) => void | Promise<void>;
}) {
  const commentDraft = useSignal("");
  const saving = status === "saving";
  const decided = gate.status === "approved" || gate.status === "rejected";

  useEffect(() => {
    if (open) commentDraft.value = "";
  }, [open]);

  const submit = (next: WorkflowGateDecision) => {
    if (saving || decided) return;
    const trimmed = commentDraft.value.trim();
    void onSubmit(next, trimmed.length ? trimmed : null);
  };

  const handleClose = () => {
    if (saving) return;
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Release decision"
      description="Approve to release the held GitHub Actions job — publishing then proceeds through PyPI Trusted Publishing (OIDC). Reject to block the job. Drydock never holds PyPI credentials or uploads the package."
    >
      <div class="flex flex-col gap-2 border border-border rounded-md p-3">
        <MonoDetail
          parts={[
            packageName ? <span key="pkg">{packageName}</span> : null,
            <span key="repo">{gate.repositoryFullName}</span>,
            <span key="env">env {gate.environment}</span>,
            <span key="run">run #{gate.runId}</span>,
          ]}
        />
        {decided ? (
          <Badge tone={gateStatusTone(gate.status)}>{gateStatusLabel(gate.status)}</Badge>
        ) : null}
      </div>

      <Field label="Comment (optional · shown in the GitHub run log)" for="gateComment">
        <Input
          id="gateComment"
          type="text"
          value={commentDraft.value}
          placeholder="e.g. reviewed changed files, no risk signals"
          onInput={(e) => (commentDraft.value = (e.target as HTMLInputElement).value)}
          disabled={saving || decided}
          maxLength={500}
          autoComplete="off"
          spellcheck={false}
        />
      </Field>

      {decided ? (
        <Muted class="m-0 text-[13px]">
          This gate has already been decided. The decision is final — GitHub has been notified.
        </Muted>
      ) : (
        <div class="flex flex-wrap gap-2">
          {canApprove ? (
            <Button onClick={() => submit("approved")} disabled={saving}>
              {saving ? "Submitting…" : "Approve & release"}
            </Button>
          ) : null}
          <Button variant="danger" onClick={() => submit("rejected")} disabled={saving}>
            {saving ? "Submitting…" : "Reject & block"}
          </Button>
        </div>
      )}
      {!decided && !canApprove ? (
        <Muted class="m-0 text-[13px]">
          Approval requires a completed review. Rejecting blocks the held GitHub job.
        </Muted>
      ) : null}
      {error ? <Alert tone="critical">{error}</Alert> : null}
    </Dialog>
  );
}
