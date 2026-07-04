import { Badge } from "./Badge";
import { Select } from "./Select";

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

  return (
    <div class="flex flex-wrap items-center gap-3">
      <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
        Compare against
      </span>
      <Select
        value={selected ?? ""}
        onChange={(value) => {
          if (value) onChange(value);
        }}
        disabled={disabled || options.length === 0}
        class="font-mono min-w-[200px]"
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
      </Select>
      <span class="font-mono text-[11px] text-ink-muted">→ staged {stagedVersion || "—"}</span>
      {tagsForSelected.map((tag) => (
        <Badge key={tag} tone="info">
          {tag}
        </Badge>
      ))}
    </div>
  );
}
