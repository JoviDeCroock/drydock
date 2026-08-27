import { useSignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { Button } from "./Button";

/**
 * Copy-to-clipboard affordance: a button plus an aria-live confirmation so the
 * result reaches screen readers without shifting the button's accessible name.
 * Clipboard access is denied outside secure contexts and in some permission
 * setups, so the failure message points at manual selection — callers must keep
 * the copied text selectable next to this button.
 */
export function CopyButton({
  text,
  label = "Copy",
  size = "sm",
  variant = "secondary",
}: {
  text: string;
  label?: string;
  size?: "sm" | "md";
  variant?: "secondary" | "ghost";
}) {
  const copyState = useSignal<"copied" | "failed" | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      copyState.value = "copied";
    } catch {
      copyState.value = "failed";
    }
  };

  return (
    <span class="inline-flex flex-wrap items-center gap-2">
      <Button variant={variant} size={size} onClick={() => void copy()}>
        {label}
      </Button>
      <span class="text-[12px] text-ink-subtle" aria-live="polite">
        <Show<"copied" | "failed" | null> when={copyState}>
          {(state) => (state === "copied" ? "Copied." : "Copy failed — select it manually.")}
        </Show>
      </span>
    </span>
  );
}
