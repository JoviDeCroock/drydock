import { useSignal } from "@preact/signals";
import { cn } from "./cn";

/**
 * Mono code block with a copy-to-clipboard control. Used by the guided setup to
 * surface generated workflow YAML and CLI commands. Follows DESIGN.md: mono
 * body, surface-2 fill, no spinner — the copied affordance is a `✓` glyph that
 * clears itself shortly after.
 */
export function CodeBlock({ code, label }: { code: string; label?: string }) {
  const copied = useSignal(false);
  const literalLabel = label?.startsWith(".") || label?.includes("/");

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      copied.value = true;
      window.setTimeout(() => (copied.value = false), 1500);
    } catch {
      // Clipboard unavailable (insecure context / denied) — the code is still
      // selectable, so silently leave the affordance untouched.
    }
  };

  return (
    <div class="border border-border rounded-lg overflow-hidden bg-surface-2">
      <div class="flex items-center justify-between gap-3 px-3 py-2 border-b border-border">
        <span
          class={cn(
            "font-mono text-[10px] text-ink-subtle",
            literalLabel ? "tracking-normal break-all" : "uppercase tracking-[0.1em]",
          )}
        >
          {label ?? "snippet"}
        </span>
        <button
          type="button"
          onClick={() => void onCopy()}
          class="font-mono text-[11px] text-ink-muted hover:text-ink transition-colors duration-150 ease-out cursor-pointer"
        >
          {copied.value ? "copied ✓" : "copy"}
        </button>
      </div>
      <pre class="m-0 px-3 py-3 overflow-x-auto">
        <code class="font-mono text-[12px] leading-[1.55] whitespace-pre text-ink">{code}</code>
      </pre>
    </div>
  );
}
