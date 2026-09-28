import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { pluralize } from "../../lib/format";
import { npmStagedPackagesListUrlFor } from "../../lib/npm-staged-url";
import type { BatchApprovalCandidate, BatchApprovalResult } from "../../models/scan-batch-approval";
import { Alert } from "../../components/Alert";
import { Button, LinkButton } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Field } from "../../components/Field";
import { Input } from "../../components/Input";
import { Muted } from "../../components/Typography";

const count = (n: number, word: string) => `${n} ${pluralize(word, n)}`;

/**
 * Approve several low-risk staged reviews at once. The list is what the server
 * says qualifies; unticking a release leaves it for its own decision. After
 * saving, the dialog says what happened and where the release is finished,
 * since approving here publishes nothing.
 */
export function BatchApprovalDialog({
  open,
  onClose,
  candidates,
  more,
  saving,
  error,
  onApprove,
}: {
  open: boolean;
  onClose: () => void;
  candidates: readonly BatchApprovalCandidate[];
  more: boolean;
  saving: boolean;
  error: string | null;
  onApprove: (scanIds: string[], reason: string | null) => Promise<BatchApprovalResult | null>;
}) {
  const excluded = useSignal<ReadonlySet<string>>(new Set());
  const reasonDraft = useSignal("");
  const result = useSignal<BatchApprovalResult | null>(null);
  // What was submitted, kept for the result view: the list refresh that
  // follows an approval drops the approved rows from `candidates`.
  const submitted = useSignal<readonly BatchApprovalCandidate[]>([]);
  // Spans the approval and the list refresh after it, which `saving` does not,
  // so the form cannot be submitted twice before the result view shows.
  const submitting = useSignal(false);
  const busy = saving || submitting.value;

  useEffect(() => {
    if (!open) return;
    excluded.value = new Set();
    reasonDraft.value = "";
    result.value = null;
    submitted.value = [];
  }, [open]);

  const selected = candidates.filter((scan) => !excluded.value.has(scan.id));
  const toggle = (id: string, checked: boolean) => {
    const next = new Set(excluded.value);
    if (checked) next.delete(id);
    else next.add(id);
    excluded.value = next;
  };
  const submit = async () => {
    if (busy || !selected.length) return;
    const trimmed = reasonDraft.value.trim();
    submitted.value = selected;
    submitting.value = true;
    try {
      result.value = await onApprove(
        selected.map((scan) => scan.id),
        trimmed.length ? trimmed : null,
      );
    } finally {
      submitting.value = false;
    }
  };
  const handleClose = () => {
    if (busy) return;
    onClose();
  };

  const done = result.value;
  if (done) {
    const approved = new Set(done.approved.map((row) => row.id));
    const npmUrl = npmStagedPackagesListUrlFor(
      submitted.value.filter((scan) => approved.has(scan.id)),
    );
    return (
      <Dialog open={open} onClose={handleClose} title="Releases approved">
        <p class="m-0 text-[13px] leading-[1.6] text-ink">
          {`Approved ${count(done.approved.length, "release")} in Drydock. Nothing is published yet: approve ${done.approved.length === 1 ? "its stage" : "the stages"} on npm, with 2FA, to release ${done.approved.length === 1 ? "it" : "them"}.`}
        </p>
        {done.skipped.length ? (
          <Alert tone="warn">
            {`${count(done.skipped.length, "release")} changed since this list loaded and ${done.skipped.length === 1 ? "was" : "were"} left undecided. Decide ${done.skipped.length === 1 ? "it" : "them"} from ${done.skipped.length === 1 ? "its" : "their"} review.`}
          </Alert>
        ) : null}
        <div class="flex flex-wrap gap-2">
          {npmUrl && done.approved.length ? (
            <LinkButton href={npmUrl} target="_blank" rel="noopener noreferrer">
              Open npm staged packages
            </LinkButton>
          ) : null}
          <Button variant="secondary" onClick={handleClose}>
            Done
          </Button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      size="md"
      title="Approve low-risk releases"
      description="These reviews read likely safe. Approving records one decision for each and publishes nothing. Approve here before you approve on npm: the publication monitor counts only an approval that came first."
    >
      <ul class="list-none m-0 p-0 flex flex-col border border-border rounded-md divide-y divide-border max-h-[320px] overflow-y-auto">
        {candidates.map((scan) => {
          const label = `${scan.packageName ?? "unknown package"}@${scan.stagedVersion ?? "?"}`;
          return (
            <li key={scan.id} class="flex items-center gap-3 px-3 py-2">
              <input
                type="checkbox"
                aria-label={`Approve ${label}`}
                checked={!excluded.value.has(scan.id)}
                onChange={(e) => toggle(scan.id, (e.target as HTMLInputElement).checked)}
                disabled={busy}
              />
              {/* Wraps rather than truncates: the version is what is being approved. */}
              <a
                href={`/dashboard/scans/${encodeURIComponent(scan.id)}`}
                target="_blank"
                rel="noopener"
                class="font-mono text-[13px] text-ink underline-offset-2 hover:underline min-w-0 break-all"
              >
                {label}
              </a>
              <span class="ml-auto font-mono text-[11px] text-ink-subtle shrink-0">
                {scan.releaseFindingCount
                  ? count(scan.releaseFindingCount, "finding")
                  : "no findings"}
              </span>
            </li>
          );
        })}
      </ul>
      <Muted class="text-[13px] m-0">
        {more ? "Showing the newest 50. " : ""}
        Reviews with higher risk, a skipped comparison, or an AI flag are not listed; decide those
        one at a time.
      </Muted>
      <Field label="Reason (optional)" for="batchDecisionReason">
        <Input
          id="batchDecisionReason"
          type="text"
          value={reasonDraft.value}
          placeholder="e.g. monorepo release, reviewed together"
          onInput={(e) => (reasonDraft.value = (e.target as HTMLInputElement).value)}
          disabled={busy}
          maxLength={500}
          autoComplete="off"
          spellcheck={false}
        />
      </Field>
      <div class="flex flex-wrap gap-2">
        <Button onClick={() => void submit()} disabled={busy || !selected.length}>
          {busy ? "Saving…" : `Approve ${count(selected.length, "release")}`}
        </Button>
        <Button variant="secondary" onClick={handleClose} disabled={busy}>
          Cancel
        </Button>
      </div>
      {error ? <Alert tone="critical">{error}</Alert> : null}
    </Dialog>
  );
}
