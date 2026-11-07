import { useEffect } from "preact/hooks";
import { useSignal } from "@preact/signals";
import { formatDateTime } from "../../../lib/format";
import type { DecisionStatus, ScanDecision, ScanListItem } from "../../../models/scan";
import type { PostReleaseReviewLink } from "../../../models/scan-api";
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
import { registryStatusVariant } from "../../../features/registry-status";
import { verdictTextClass } from "../../../features/review/verdict";
import type { ReleaseRecommendationCopy } from "../recommendation";

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
  postRelease = null,
  verdict = null,
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
    | "decision"
  >;
  /**
   * Drydock's verdict on this release. It decides which outcome the dialog
   * offers as its primary action, so a blocked verdict never opens on a
   * filled "Record approval".
   */
  verdict?: SignalOrValue<{
    recommendation: Pick<ReleaseRecommendationCopy, "label" | "tone">;
  } | null>;
  /**
   * Set when this review answers a publication alert: the release is already
   * public, so the decision is about it after release, and there is no stage
   * to finish on npm.
   */
  postRelease?: PostReleaseReviewLink | null;
  onSubmit: (decision: ScanDecision, reason: string | null) => boolean | Promise<boolean>;
}) {
  const reasonDraft = useSignal("");
  const isOpen = readSignalProp(open);
  const saving = readSignalProp(status) === "saving";
  const message = readSignalProp(error);
  const stagedUrl =
    postRelease || npmStagedPackagesUrl === undefined ? null : readSignalProp(npmStagedPackagesUrl);

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
    const command = postRelease ? null : npmStageCommandFor(next, scan);
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

  const recommendation = readSignalProp(verdict)?.recommendation ?? null;
  const advisesRejection = recommendation?.tone === "critical" || recommendation?.tone === "high";
  // A published-pair review and a stage npm has since published both judge a
  // release that is already public.
  const alreadyPublished =
    !postRelease && (scan.source === "published" || registryStatusVariant(scan) === "published");
  const subject =
    scan.packageName && scan.stagedVersion ? `${scan.packageName}@${scan.stagedVersion}` : null;
  const approveLabel = saving
    ? "Saving…"
    : postRelease || alreadyPublished
      ? "Approve after release"
      : "Record approval";
  const rejectLabel = saving
    ? "Saving…"
    : postRelease || alreadyPublished
      ? "Decline after release"
      : "Record rejection";

  const handleClose = () => {
    if (saving) return;
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={postRelease || alreadyPublished ? "Decision after release" : "Review decision"}
      description={
        postRelease
          ? `${postRelease.packageName}@${postRelease.version} is already public on npm. Record whether this organization approves the published release: approving resolves its publication alert when the reviewed bytes match the published ones, declining keeps the alert open with next steps. If this organization is a registry-verified publisher of the package and the reviewed bytes match the published ones, the public badge shows it as approved or rejected. Nothing changes on npm.`
          : alreadyPublished
            ? "This version is already published. Record whether this organization approves it; nothing changes on the registry."
            : `Record an advisory review decision.${
                // Published-pair reviews are not release records the monitor reads.
                scan.source === "manual" || scan.source === "auto_discovery"
                  ? " Confirm it separately in npm with 2FA. Approving here before publication lets the publication monitor match the released bytes to your decision."
                  : ""
              }`
      }
    >
      {subject || recommendation ? (
        <p class="m-0 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px]">
          {subject ? <span class="font-mono text-ink break-all">{subject}</span> : null}
          {recommendation ? (
            <span class={verdictTextClass(recommendation.tone)}>
              Drydock: {recommendation.label}
            </span>
          ) : null}
        </p>
      ) : null}
      {decision ? (
        <div class="flex flex-col gap-2 border border-border rounded-md p-3">
          <div class="flex flex-wrap items-center gap-2">
            <Badge tone={decision === "publish" ? "ok" : "critical"}>
              {decision === "publish" ? "approval recorded" : "rejection recorded"}
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
          placeholder="e.g. reviewed the changed files and install scripts"
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

      {/* One filled action, chosen by the verdict: the outcome Drydock
          advises leads, the other stays available as a secondary button. */}
      <div class="flex flex-wrap items-center gap-2">
        {advisesRejection ? (
          <>
            <Button variant="danger" onClick={() => submit("no_publish")} disabled={saving}>
              {rejectLabel}
            </Button>
            <Button variant="secondary" onClick={() => submit("publish")} disabled={saving}>
              {approveLabel}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => submit("publish")} disabled={saving}>
              {approveLabel}
            </Button>
            <Button variant="secondary" onClick={() => submit("no_publish")} disabled={saving}>
              {rejectLabel}
            </Button>
          </>
        )}
        <Button variant="ghost" class="ml-auto" onClick={handleClose} disabled={saving}>
          Cancel
        </Button>
      </div>
      {message ? <Alert tone="critical">{message}</Alert> : null}
    </Dialog>
  );
}
