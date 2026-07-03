import { useEffect } from "preact/hooks";
import { useSignal } from "@preact/signals";
import { formatDateTime } from "../../../lib/format";
import type { DecisionStatus, ScanDecision } from "../../../models/scan";
import { Alert } from "../../../components/Alert";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";

export function DecisionDialog({
  open,
  onClose,
  decision,
  decisionReason,
  decidedAt,
  status,
  error,
  npmStagedPackagesUrl,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  decision?: string | null;
  decisionReason?: string | null;
  decidedAt?: string | number | Date | null;
  status: DecisionStatus;
  error: string | null;
  npmStagedPackagesUrl?: string | null;
  onSubmit: (decision: ScanDecision, reason: string | null) => boolean | Promise<boolean>;
}) {
  const reasonDraft = useSignal("");
  const openNpmAfterSave = useSignal(false);
  const saving = status === "saving";

  useEffect(() => {
    if (open) {
      reasonDraft.value = decisionReason ?? "";
      openNpmAfterSave.value = false;
    }
  }, [open, decisionReason]);

  const submit = async (next: ScanDecision) => {
    if (saving) return;
    const shouldOpenNpm = Boolean(npmStagedPackagesUrl && openNpmAfterSave.peek());
    const npmWindow = shouldOpenNpm ? window.open("about:blank", "_blank") : null;
    if (npmWindow) npmWindow.opener = null;
    const trimmed = reasonDraft.value.trim();
    const saved = await onSubmit(next, trimmed.length ? trimmed : null);
    if (saved && npmWindow && npmStagedPackagesUrl) {
      npmWindow.location.href = npmStagedPackagesUrl;
    } else if (!saved) {
      npmWindow?.close();
    }
  };

  const handleClose = () => {
    if (saving) return;
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Publish decision"
      description="Record whether this staged publish is safe to approve. This adds to the audit trail, but it does not publish or cancel anything on npm. You still confirm or cancel with 2FA there."
    >
      {decision ? (
        <div class="flex flex-col gap-2 border border-border rounded-md p-3">
          <div class="flex flex-wrap items-center gap-2">
            <Badge tone={decision === "publish" ? "ok" : "critical"}>
              {decision === "publish" ? "currently approved" : "currently blocked"}
            </Badge>
            {decidedAt ? (
              <span class="font-mono text-[11px] text-ink-subtle">{formatDateTime(decidedAt)}</span>
            ) : null}
          </div>
          {decisionReason ? (
            <p class="m-0 text-[13px] leading-[1.6] text-ink-muted">{decisionReason}</p>
          ) : null}
        </div>
      ) : null}

      <Field label="Reason (optional)" for="decisionReason">
        <Input
          id="decisionReason"
          type="text"
          value={reasonDraft.value}
          placeholder="e.g. minor patch, no risk signals"
          onInput={(e) => (reasonDraft.value = (e.target as HTMLInputElement).value)}
          disabled={saving}
          maxLength={500}
          autoComplete="off"
          spellcheck={false}
        />
      </Field>

      {npmStagedPackagesUrl ? (
        <label class="flex items-center gap-2 text-[13px] text-ink-muted">
          <input
            type="checkbox"
            checked={openNpmAfterSave.value}
            onChange={(e) => (openNpmAfterSave.value = (e.target as HTMLInputElement).checked)}
            disabled={saving}
          />
          Open npm staged packages in a new tab after saving
        </label>
      ) : null}

      <div class="flex flex-wrap gap-2">
        <Button onClick={() => submit("publish")} disabled={saving}>
          {saving ? "Saving…" : "Approve publish"}
        </Button>
        <Button variant="danger" onClick={() => submit("no_publish")} disabled={saving}>
          {saving ? "Saving…" : "Block publish"}
        </Button>
      </div>
      {error ? <Alert tone="critical">{error}</Alert> : null}
    </Dialog>
  );
}
