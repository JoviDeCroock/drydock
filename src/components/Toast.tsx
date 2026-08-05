import { signal } from "@preact/signals";
import { cn } from "./cn";
import { CloseButton } from "./CloseButton";

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
// that stacked toasts clear themselves without manual dismissal. Critical
// toasts are errors and never auto-dismiss: losing an OAuth failure message
// after 4s means losing the only record of what went wrong.
const TOAST_TTL_MS = 4000;

const timers = new Map<number, ReturnType<typeof setTimeout>>();

export function pushToast(message: string, tone: ToastTone = "info"): void {
  const id = ++nextId;
  items.value = [...items.value, { id, tone, message }];
  if (tone !== "critical") scheduleToastDismiss(id);
}

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
  holds.delete(id);
  items.value = items.value.filter((item) => item.id !== id);
}

function scheduleToastDismiss(id: number): void {
  timers.set(
    id,
    setTimeout(() => dismissToast(id), TOAST_TTL_MS),
  );
}

// Hover/focus pause: while a user is reading (pointer over the toast) or
// interacting (focus on its dismiss button), the clock stops; the last release
// restarts a full TTL. Holds are refcounted because hover and focus overlap —
// un-counted, mouse-leave would restart the timer while keyboard focus was
// still inside the toast (and dismissal would then strand focus on <body>).
// Exported for tests.
const holds = new Map<number, number>();

export function holdToast(id: number): void {
  holds.set(id, (holds.get(id) ?? 0) + 1);
  const timer = timers.get(id);
  if (timer === undefined) return;
  clearTimeout(timer);
  timers.delete(id);
}

export function releaseToast(id: number): void {
  const count = holds.get(id) ?? 0;
  if (count > 1) {
    holds.set(id, count - 1);
    return;
  }
  holds.delete(id);
  const item = items.value.find((entry) => entry.id === id);
  if (!item || item.tone === "critical") return;
  if (timers.has(id)) return;
  scheduleToastDismiss(id);
}

// The colored disc mirrors the Alert indicator — the only filled-shape exception
// in the system (see docs/design.md Iconography). Saturated severity tokens are fine
// here because the disc is a shape, not text.
const toneDisc: Record<ToastTone, string> = {
  ok: "bg-ok",
  critical: "bg-danger",
  info: "bg-info",
};

export function Toaster() {
  return (
    <div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-[min(92vw,360px)] pointer-events-none">
      {items.value.map((item) => (
        <div
          key={item.id}
          class="pointer-events-auto flex items-start gap-2.5 bg-surface border border-border rounded-lg shadow-md px-3.5 py-3"
          role={item.tone === "critical" ? "alert" : "status"}
          onMouseEnter={() => holdToast(item.id)}
          onMouseLeave={() => releaseToast(item.id)}
          onFocusIn={() => holdToast(item.id)}
          onFocusOut={() => releaseToast(item.id)}
        >
          <span
            class={cn("w-4 h-4 rounded-full shrink-0 mt-0.5 opacity-90", toneDisc[item.tone])}
            aria-hidden
          />
          <span class="text-[13px] leading-[1.5] text-ink flex-1">{item.message}</span>
          <CloseButton
            onClick={() => dismissToast(item.id)}
            ariaLabel="Dismiss"
            class="shrink-0 -mr-1 -mt-0.5 text-[13px] text-ink-subtle hover:text-ink"
          />
        </div>
      ))}
    </div>
  );
}

// Test-only escape hatch: reset the module-level store between cases.
export function clearToastsForTest(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  holds.clear();
  items.value = [];
}

export function toastItemsForTest(): readonly ToastItem[] {
  return items.value;
}
