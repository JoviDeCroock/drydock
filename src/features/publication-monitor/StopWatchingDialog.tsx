import type { ReadonlySignal } from "@preact/signals";
import { ConfirmDialog } from "../../components/Dialog";

/**
 * Stopping deletes the watch's observations and persists an opt-out, so both
 * surfaces that offer it confirm first and say what survives: the alert
 * ledger, which the package page keeps listing.
 */
export function StopWatchingDialog({
  packageName,
  busy,
  onClose,
  onConfirm,
}: {
  /** The package to stop watching; null keeps the dialog closed. */
  packageName: ReadonlySignal<string | null>;
  busy: ReadonlySignal<boolean>;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const name = packageName.value;
  return (
    <ConfirmDialog
      open={name !== null}
      onClose={onClose}
      title={`Stop watching ${name ?? "this package"}?`}
      description="Its release observations leave the dashboard, and automatic enrollment will not watch it again. You can watch it again by hand at any time."
      busy={busy}
      busyLabel="Stopping…"
      confirmLabel="Stop watching"
      onConfirm={onConfirm}
    >
      <p class="m-0 text-[13px] leading-[1.55] text-ink-muted">
        Alerts already raised for it stay listed on the package's page.
      </p>
    </ConfirmDialog>
  );
}
