import type { JSX } from "preact";
import { Badge } from "./Badge";
import { cn } from "./cn";

interface VersionOption {
  version: string;
  distTags: string[];
  publishedAt?: string;
}

export function VersionPicker({
  options,
  selected,
  defaultVersion,
  stagedVersion,
  onChange,
  disabled,
}: {
  options: VersionOption[];
  selected: string | null;
  defaultVersion: string | null;
  stagedVersion: string | null;
  onChange: (version: string) => void;
  disabled?: boolean;
}) {
  const tagsForSelected = options.find((option) => option.version === selected)?.distTags ?? [];

  const handleChange: JSX.GenericEventHandler<HTMLSelectElement> = (event) => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (value) onChange(value);
  };

  return (
    <div class="flex flex-wrap items-center gap-3">
      <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
        Compare against
      </span>
      <div class="relative inline-block">
        <select
          value={selected ?? ""}
          onChange={handleChange}
          disabled={disabled || options.length === 0}
          class={cn(
            "appearance-none bg-bg border border-border rounded-md text-[13px] text-ink pl-3 pr-9 py-2 outline-none",
            "focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-soft)]",
            "disabled:opacity-60 disabled:cursor-not-allowed",
            "font-mono min-w-[200px] w-full",
          )}
        >
          {!options.length ? <option value="">no published versions</option> : null}
          {options.map((option) => {
            const tagSuffix = option.distTags.length ? ` [${option.distTags.join(", ")}]` : "";
            const defaultSuffix = option.version === defaultVersion ? " (default)" : "";
            return (
              <option key={option.version} value={option.version}>
                {option.version}
                {tagSuffix}
                {defaultSuffix}
              </option>
            );
          })}
        </select>
        <span
          aria-hidden="true"
          class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-ink-muted"
        >
          ▾
        </span>
      </div>
      <span class="font-mono text-[11px] text-ink-muted">→ staged {stagedVersion || "—"}</span>
      {tagsForSelected.map((tag) => (
        <Badge key={tag} tone="info">
          {tag}
        </Badge>
      ))}
    </div>
  );
}
