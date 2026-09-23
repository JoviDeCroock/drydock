import { useEffect } from "preact/hooks";
import { useSignal } from "@preact/signals";
import { formatDateTime } from "../../../lib/format";
import type { DecisionStatus, ScanDecision, ScanListItem } from "../../../models/scan";
import { openNpmAfterDecision, setOpenNpmAfterDecision } from "../../../models/publish-preferences";
import { showStageCommandPrompt } from "../../../models/stage-command-prompt";
import { npmStageCommandFor } from "../../../lib/npm-stage-command";
import { Alert } from "../../../components/Alert";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { readSignalProp, type SignalOrValue } from "../../../components/signal-props";

export function DecisionDialog({
  open,
  onClose,
  decision,
  decisionReason,
  decidedAt,
  status,
  error,
  npmStagedPackagesUrl,
  scan,
  onSubmit,
}: {
  // Signals are read here rather than by the page: opening the dialog and the
  // save round-trip (idle → saving → idle/error) then re-render the dialog
  // alone, not a page that also renders one card per finding.
  open: SignalOrValue<boolean>;
  onClose: () => void;
  decision?: string | null;
  decisionReason?: string | null;
  decidedAt?: string | number | Date | null;
  status: SignalOrValue<DecisionStatus>;
  error: SignalOrValue<string | null>;
  npmStagedPackagesUrl?: SignalOrValue<string | null>;
  /** Identifies the stage for the follow-up CLI command. */
  scan: Pick<
    ScanListItem,
    | "stageId"
    | "packageName"
    | "stagedVersion"
    | "source"
    | "registryUrl"
    | "registryVersionStatus"
    | "registryStatusSupersededAt"
  >;
  onSubmit: (decision: ScanDecision, reason: string | null) => boolean | Promise<boolean>;
}) {
  const reasonDraft = useSignal("");
  const isOpen = readSignalProp(open);
  const saving = readSignalProp(status) === "saving";
  const message = readSignalProp(error);
  const stagedUrl =
    npmStagedPackagesUrl === undefined ? null : readSignalProp(npmStagedPackagesUrl);

  useEffect(() => {
    if (isOpen) {
      reasonDraft.value = decisionReason ?? "";
    }
  }, [isOpen, decisionReason]);

  const submit = async (next: ScanDecision) => {
    if (saving) return;
    const shouldOpenNpm = Boolean(stagedUrl && openNpmAfterDecision.peek());
    const npmWindow = shouldOpenNpm ? window.open("about:blank", "_blank") : null;
    if (npmWindow) npmWindow.opener = null;
    const trimmed = reasonDraft.value.trim();
    const saved = await onSubmit(next, trimmed.length ? trimmed : null);
    if (!saved) {
      npmWindow?.close();
      return;
    }
    if (npmWindow && stagedUrl) {
      npmWindow.location.href = stagedUrl;
      return;
    }
    // Nobody is going to npm's web UI for us: either the reviewer finishes in a
    // terminal, or the tab we tried to open was blocked. Both cases end with the
    // same open question — what exactly do I run — so answer it.
    const command = npmStageCommandFor(next, scan);
    if (command) {
      showStageCommandPrompt({
        decision: next,
        command,
        packageName: scan.packageName,
        stagedVersion: scan.stagedVersion,
        npmStagedPackagesUrl: stagedUrl,
      });
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

      {stagedUrl ? (
        <label class="flex items-start gap-2 text-[13px] text-ink-muted">
          <input
            type="checkbox"
            class="mt-1"
            checked={openNpmAfterDecision.value}
            onChange={(e) => setOpenNpmAfterDecision((e.target as HTMLInputElement).checked)}
            disabled={saving}
          />
          <span class="flex flex-col gap-0.5">
            Open npm staged packages in a new tab after saving
            {/* Inside the label so the stickiness is part of the checkbox's
                accessible name — no id/aria-describedby plumbing needed. */}
            <span class="text-[12px] text-ink-subtle">Remembered on this browser.</span>
          </span>
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
      {message ? <Alert tone="critical">{message}</Alert> : null}
    </Dialog>
  );
}
