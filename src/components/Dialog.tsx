import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
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
      <div class="flex flex-col gap-4 p-5">
        <header class="flex flex-col gap-1">
          <h2 class="text-[18px] font-medium tracking-[-0.01em] leading-[1.35] m-0">{title}</h2>
          {description ? (
            <p class="text-[13px] leading-[1.55] text-ink-muted m-0">{description}</p>
          ) : null}
        </header>
        <div class="flex flex-col gap-3">{children}</div>
        {footer ? <footer class="flex flex-wrap justify-end gap-2 pt-1">{footer}</footer> : null}
      </div>
    </dialog>
  );
}
