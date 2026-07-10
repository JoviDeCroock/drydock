import type { DeleteStatus } from "../../../models/scan";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";

export function DeleteScanDialog({
  open,
  onClose,
  packageName,
  status,
  error,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  packageName?: string | null;
  status: DeleteStatus;
  error: string | null;
  onConfirm: () => boolean | Promise<boolean>;
}) {
  const deleting = status === "deleting";
  const handleClose = () => {
    if (!deleting) onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Delete failed review?"
      description={`This permanently deletes the failed review${packageName ? ` for ${packageName}` : ""} and its stored evidence. This action cannot be undone.`}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={handleClose} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={() => void onConfirm()} disabled={deleting}>
            {deleting ? "Deleting…" : "Delete review"}
          </Button>
        </>
      }
    >
      <p class="m-0 text-[13px] leading-[1.55] text-ink-muted">
        Completed, pending, and running reviews cannot be deleted.
      </p>
      {error ? <Alert tone="critical">{error}</Alert> : null}
    </Dialog>
  );
}
