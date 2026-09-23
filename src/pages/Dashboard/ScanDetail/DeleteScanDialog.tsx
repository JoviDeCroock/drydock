import type { DeleteStatus } from "../../../models/scan";
import { Alert } from "../../../components/Alert";
import { ConfirmDialog } from "../../../components/Dialog";
import { readSignalProp, type SignalOrValue } from "../../../components/signal-props";

export function DeleteScanDialog({
  open,
  onClose,
  packageName,
  status,
  error,
  onConfirm,
}: {
  open: SignalOrValue<boolean>;
  onClose: () => void;
  packageName?: string | null;
  status: SignalOrValue<DeleteStatus>;
  error: SignalOrValue<string | null>;
  onConfirm: () => boolean | Promise<boolean>;
}) {
  // Read here, not in the page: the delete round-trip re-renders this dialog
  // alone rather than the review it sits on.
  const deleting = readSignalProp(status) === "deleting";
  const message = readSignalProp(error);

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title="Delete failed review?"
      description={`This permanently deletes the failed review${packageName ? ` for ${packageName}` : ""} and its stored evidence. This action cannot be undone.`}
      busy={deleting}
      busyLabel="Deleting…"
      confirmLabel="Delete review"
      onConfirm={() => void onConfirm()}
    >
      <p class="m-0 text-[13px] leading-[1.55] text-ink-muted">
        Completed, pending, and running reviews cannot be deleted.
      </p>
      {message ? <Alert tone="critical">{message}</Alert> : null}
    </ConfirmDialog>
  );
}
