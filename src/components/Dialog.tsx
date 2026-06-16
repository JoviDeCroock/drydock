import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";
import { cn } from "./cn";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ComponentChildren;
  footer?: ComponentChildren;
  class?: string;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
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

  const onBackdropClick = (event: MouseEvent) => {
    if (event.target === ref.current) onClose();
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onClose={onClose}
      onCancel={onCancel}
      onClick={onBackdropClick}
      class={cn(
        "p-0 m-auto bg-surface text-ink border border-border rounded-lg shadow-md",
        "w-[min(92vw,440px)] max-w-[440px]",
        "backdrop:bg-black/40",
        className,
      )}
    >
      <div class="relative flex flex-col gap-4 p-5">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          class="absolute top-3 right-3 flex items-center justify-center w-7 h-7 rounded-md text-ink-subtle hover:text-ink hover:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-accent leading-none text-[14px]"
        >
          ✕
        </button>
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
      </div>
    </dialog>
  );
}
