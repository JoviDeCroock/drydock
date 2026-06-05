import { signal } from "@preact/signals";
import { cn } from "./cn";

export type ToastTone = "ok" | "critical" | "info";

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

// Module-level store so any surface can fire a toast without threading a model
// or context down to it. A single <Toaster/> at the app root renders this list.
const items = signal<ToastItem[]>([]);
let nextId = 0;

// Transient confirmations only — long enough to read one sentence, short enough
// that stacked toasts clear themselves without manual dismissal.
const TOAST_TTL_MS = 4000;

export function pushToast(message: string, tone: ToastTone = "info"): void {
  const id = ++nextId;
  items.value = [...items.value, { id, tone, message }];
  setTimeout(() => dismissToast(id), TOAST_TTL_MS);
}

export function dismissToast(id: number): void {
  items.value = items.value.filter((item) => item.id !== id);
}

// The colored disc mirrors the Alert indicator — the only filled-shape exception
// in the system (see DESIGN.md Iconography). Saturated severity tokens are fine
// here because the disc is a shape, not text.
const toneDisc: Record<ToastTone, string> = {
  ok: "bg-ok",
  critical: "bg-danger",
  info: "bg-info",
};

export function Toaster() {
  return (
    <div
      class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-[min(92vw,360px)] pointer-events-none"
      aria-live="polite"
    >
      {items.value.map((item) => (
        <div
          key={item.id}
          class="pointer-events-auto flex items-start gap-2.5 bg-surface border border-border rounded-lg shadow-md px-3.5 py-3"
          role="status"
        >
          <span
            class={cn("w-4 h-4 rounded-full shrink-0 mt-0.5 opacity-90", toneDisc[item.tone])}
            aria-hidden
          />
          <span class="text-[13px] leading-[1.5] text-ink flex-1">{item.message}</span>
          <button
            type="button"
            onClick={() => dismissToast(item.id)}
            aria-label="Dismiss"
            class="shrink-0 -mr-1 -mt-0.5 leading-none text-[13px] text-ink-subtle hover:text-ink"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
