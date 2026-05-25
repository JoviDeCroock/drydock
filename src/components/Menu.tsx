import type { ComponentChildren, JSX } from "preact";
import { useRef } from "preact/hooks";
import { useSignal, useSignalEffect } from "@preact/signals";
import { cn } from "./cn";

interface MenuProps {
  trigger: (open: boolean) => ComponentChildren;
  children: ComponentChildren;
  align?: "start" | "end";
  triggerClass?: string;
  triggerAriaLabel?: string;
  panelClass?: string;
  disabled?: boolean;
}

export function Menu({
  trigger,
  children,
  align = "start",
  triggerClass,
  triggerAriaLabel,
  panelClass,
  disabled,
}: MenuProps) {
  const open = useSignal(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useSignalEffect(() => {
    if (!open.value) return;
    const onPointer = (event: PointerEvent) => {
      const node = rootRef.current;
      if (!node) return;
      if (event.target instanceof Node && !node.contains(event.target)) {
        open.value = false;
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") open.value = false;
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  });

  const onPanelClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("[data-menu-item]")) open.value = false;
  };

  return (
    <div ref={rootRef} class="relative inline-block">
      <button
        type="button"
        onClick={() => {
          if (disabled) return;
          open.value = !open.value;
        }}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open.value}
        aria-label={triggerAriaLabel}
        class={cn("cursor-pointer disabled:cursor-not-allowed disabled:opacity-60", triggerClass)}
      >
        {trigger(open.value)}
      </button>
      {open.value ? (
        <div
          role="menu"
          onClick={onPanelClick}
          class={cn(
            "absolute z-20 mt-1 min-w-[200px] bg-surface border border-border rounded-md shadow-md py-1",
            align === "end" ? "right-0" : "left-0",
            panelClass,
          )}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

type MenuItemProps = Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "class" | "onClick"> & {
  onSelect?: () => void;
  tone?: "default" | "accent";
  active?: boolean;
  class?: string;
  children: ComponentChildren;
};

export function MenuItem({
  onSelect,
  tone = "default",
  active = false,
  class: className,
  children,
  type = "button",
  disabled,
  ...props
}: MenuItemProps) {
  return (
    <button
      type={type}
      data-menu-item
      role="menuitem"
      onClick={onSelect}
      disabled={disabled}
      class={cn(
        "w-full text-left text-[13px] px-3 py-1.5 cursor-pointer",
        "hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
        tone === "accent" ? "text-accent" : "text-ink",
        active ? "font-medium" : "",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function MenuSeparator() {
  return <div class="my-1 border-t border-border" />;
}

export function MenuLabel({ children }: { children: ComponentChildren }) {
  return (
    <div class="px-3 py-1.5 text-[11px] font-mono text-ink-subtle uppercase tracking-[0.08em]">
      {children}
    </div>
  );
}
