import type { ComponentChildren, JSX } from "preact";
import { useId, useRef } from "preact/hooks";
import { useComputed, useSignal, useSignalEffect } from "@preact/signals";
import { Show, useLiveSignal } from "@preact/signals/utils";
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
  const focusFirstOnOpen = useSignal(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();

  // `trigger` is a plain prop whose closure can change (e.g. its label derives
  // from parent state) without `open` changing. Track it via a live signal so
  // the computed recomputes when the prop updates, not only on open toggles.
  const triggerSignal = useLiveSignal(trigger);
  const triggerContent = useComputed(() => triggerSignal.value(open.value));

  const getEnabledMenuItems = () => {
    const node = rootRef.current;
    if (!node) return [];
    return Array.from(node.querySelectorAll<HTMLElement>("[data-menu-item]:not([disabled])"));
  };

  const focusMenuItem = (index: number) => {
    const items = getEnabledMenuItems();
    if (!items.length) return;
    const nextIndex = ((index % items.length) + items.length) % items.length;
    items[nextIndex]?.focus();
  };

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
      if (event.key !== "Escape") return;
      open.value = false;
      focusFirstOnOpen.value = false;
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  });

  useSignalEffect(() => {
    if (!open.value || !focusFirstOnOpen.value) return;
    const frame = requestAnimationFrame(() => {
      focusMenuItem(0);
      focusFirstOnOpen.value = false;
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  });

  const onRootKeyDown = (event: KeyboardEvent) => {
    const key = event.key;
    if (disabled) return;

    if (event.target === triggerRef.current && !open.value) {
      if (key === "Enter" || key === " " || key === "ArrowDown") {
        event.preventDefault();
        open.value = true;
        focusFirstOnOpen.value = true;
      }
      return;
    }

    if (!open.value) return;

    if (key === "Escape") {
      event.preventDefault();
      open.value = false;
      focusFirstOnOpen.value = false;
      triggerRef.current?.focus();
      return;
    }

    if (key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End") {
      event.preventDefault();
      const items = getEnabledMenuItems();
      if (!items.length) return;
      const active = document.activeElement;
      const currentIndex = items.indexOf(active as HTMLElement);
      let nextIndex = 0;
      if (key === "Home") {
        nextIndex = 0;
      } else if (key === "End") {
        nextIndex = items.length - 1;
      } else if (currentIndex === -1) {
        nextIndex = key === "ArrowUp" ? items.length - 1 : 0;
      } else if (key === "ArrowDown") {
        nextIndex = currentIndex + 1;
      } else {
        nextIndex = currentIndex - 1;
      }
      focusMenuItem(nextIndex);
    }
  };

  const onPanelClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    if (!target?.closest("[data-menu-item]")) return;
    open.value = false;
    // The activated item unmounts with the panel; without this, keyboard
    // activation (Enter fires a click) strands focus on <body>.
    triggerRef.current?.focus();
  };

  // Tabbing out of the menu should close it — Tab is not menu navigation, and
  // leaving a stale open panel behind confuses both sighted keyboard users and
  // AT (aria-expanded would keep announcing "expanded").
  const onFocusOut = (event: FocusEvent) => {
    if (!open.value) return;
    const node = rootRef.current;
    const next = event.relatedTarget;
    if (node && next instanceof Node && node.contains(next)) return;
    open.value = false;
  };

  return (
    <div
      ref={rootRef}
      onKeyDown={onRootKeyDown}
      onFocusOut={onFocusOut}
      class="relative inline-block"
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          if (disabled) return;
          if (event.detail === 0) return;
          open.value = !open.value;
        }}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={triggerAriaLabel}
        class={cn("cursor-pointer disabled:cursor-not-allowed disabled:opacity-60", triggerClass)}
      >
        {triggerContent}
      </button>
      <Show when={open}>
        {() => (
          <div
            id={panelId}
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
        )}
      </Show>
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

type MenuLinkProps = {
  href: string;
  tone?: "default" | "accent";
  class?: string;
  children: ComponentChildren;
};

// Anchor counterpart to MenuItem for in-app navigation: preact-iso intercepts
// the click for client-side routing, and the `data-menu-item` marker lets the
// panel close on select just like a button item.
export function MenuLink({ href, tone = "default", class: className, children }: MenuLinkProps) {
  return (
    <a
      href={href}
      data-menu-item
      role="menuitem"
      class={cn(
        "block w-full text-left text-[13px] px-3 py-1.5 cursor-pointer no-underline",
        "hover:bg-surface-2",
        tone === "accent" ? "text-accent" : "text-ink",
        className,
      )}
    >
      {children}
    </a>
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
