import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";
import { CloseButton } from "./CloseButton";
import { cn } from "./cn";

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
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ComponentChildren;
  footer?: ComponentChildren;
  size?: DialogSize;
  class?: string;
}

export function Dialog({
  open,
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
        <CloseButton
          onClick={onClose}
          class="absolute top-3 right-3 w-7 h-7 text-[14px] text-ink-subtle hover:text-ink hover:bg-surface-2"
        />
      </div>
    </dialog>
  );
}
