import { useId } from "preact/hooks";
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
  const selectId = useId();

  return (
    <div class="flex flex-wrap items-center gap-3">
      <label
        for={selectId}
        class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle"
      >
        Compare against
      </label>
      <div class="w-full sm:w-auto sm:min-w-[200px]">
        <Select
          id={selectId}
          value={selected ?? ""}
          onChange={(value) => {
            if (value) onChange(value);
          }}
          disabled={disabled || options.length === 0}
          mono
        >
          {/* The version list can come back empty while the review still has a
              persisted baseline (the packument lookup failed, or a gate scan in
              an ecosystem the list does not cover). Name that baseline rather
              than claim nothing was published above a tree of modified files. */}
          {!options.length ? (
            <option value={selected ?? ""}>
              {defaultVersion ? `${defaultVersion} (default)` : "no published versions"}
            </option>
          ) : null}
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
      </div>
      {/* The selected option's text already names its dist-tags; a chip after
          this caption read as tagging the staged version instead. */}
      <span class="font-mono text-[11px] text-ink-muted">→ staged {stagedVersion || "—"}</span>
    </div>
  );
}
