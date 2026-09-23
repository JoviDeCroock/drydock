import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";
import { Button } from "./Button";
import { CloseButton } from "./CloseButton";
import { cn } from "./cn";
import { readSignalProp, type SignalOrValue } from "./signal-props";

/**
 * `sm` fits the prose-and-buttons default. `md` is for dialogs whose body
 * carries a fixed-width payload — a shell command, a key — that reads as
 * cramped when wrapped or scrolled at the default width.
 */
type DialogSize = "sm" | "md";

const SIZE_CLASS: Record<DialogSize, string> = {
  sm: "w-[min(92vw,440px)] max-w-[440px]",
  md: "w-[min(92vw,560px)] max-w-[560px]",
};

interface DialogProps {
  // A signal here makes the dialog its own subscriber, so opening it does not
  // re-render the page that mounts it.
  open: SignalOrValue<boolean>;
  onClose: () => void;
  title: string;
  description?: string;
  children: ComponentChildren;
  footer?: ComponentChildren;
  size?: DialogSize;
  class?: string;
}

export function Dialog({
  open: openProp,
  onClose,
  title,
  description,
  children,
  footer,
  size = "sm",
  class: className,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const open = readSignalProp(openProp);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) {
      node.showModal();
    } else if (!open && node.open) {
      node.close();
    }
  }, [open]);

  const onCancel = (event: Event) => {
    event.preventDefault();
    onClose();
  };

  // Backdrop dismissal requires the press to START on the backdrop. A click
  // alone is not enough: a text-selection drag that starts in an input and
  // ends over the backdrop dispatches its click on the <dialog> (the common
  // ancestor), which would close the dialog and discard the form.
  const pressStartedOnBackdrop = useRef(false);
  const onBackdropPointerDown = (event: PointerEvent) => {
    pressStartedOnBackdrop.current = event.target === ref.current;
  };
  const onBackdropClick = (event: MouseEvent) => {
    if (event.target === ref.current && pressStartedOnBackdrop.current) onClose();
    pressStartedOnBackdrop.current = false;
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onClose={onClose}
      onCancel={onCancel}
      onPointerDown={onBackdropPointerDown}
      onClick={onBackdropClick}
      class={cn(
        "p-0 m-auto bg-surface text-ink border border-border rounded-lg shadow-md",
        SIZE_CLASS[size],
        "backdrop:bg-black/40",
        className,
      )}
    >
      <div class="relative flex flex-col gap-4 p-5">
        <header class="flex flex-col gap-1 pr-7">
          <h2 id={titleId} class="text-[18px] font-medium tracking-[-0.01em] leading-[1.35] m-0">
            {title}
          </h2>
          {description ? (
            <p id={descriptionId} class="text-[13px] leading-[1.55] text-ink-muted m-0">
              {description}
            </p>
          ) : null}
        </header>
        <div class="flex flex-col gap-3">{children}</div>
        {footer ? <footer class="flex flex-wrap justify-end gap-2 pt-1">{footer}</footer> : null}
        {/* Rendered last (absolutely positioned top-right) so showModal()'s
            native initial focus lands on the first real control instead of
            the ✕; call-site `autofocus` still takes precedence natively. */}
        <CloseButton onClick={onClose} variant="icon" class="absolute top-3 right-3 text-[14px]" />
      </div>
    </dialog>
  );
}

/**
 * A destructive confirmation: prose, an optional body (a typed-name field, an
 * error line), and a Cancel / danger pair in the footer. When `form` names a
 * form id in the body, the danger button submits it; otherwise it calls
 * `onConfirm`. Both buttons lock while `busy`.
 */
export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  busy,
  busyLabel,
  confirmLabel,
  confirmDisabled = false,
  form,
  onConfirm,
  children,
}: {
  open: SignalOrValue<boolean>;
  onClose: () => void;
  title: string;
  description: string;
  busy: SignalOrValue<boolean>;
  busyLabel: string;
  confirmLabel: string;
  confirmDisabled?: SignalOrValue<boolean>;
  form?: string;
  onConfirm?: () => void;
  children?: ComponentChildren;
}) {
  const isBusy = readSignalProp(busy);
  // Escape, the backdrop and the ✕ stay live while the action is in flight.
  // Closing does not cancel the request, and these requests have no client
  // timeout, so a guard here only traps the reader in a dialog that may never
  // resolve. The Cancel button is disabled instead, which says the same thing
  // without taking the exits away.
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={isBusy}>
            Cancel
          </Button>
          <Button
            type={form ? "submit" : "button"}
            form={form}
            variant="danger"
            size="sm"
            onClick={form ? undefined : onConfirm}
            disabled={isBusy || readSignalProp(confirmDisabled)}
          >
            {isBusy ? busyLabel : confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
