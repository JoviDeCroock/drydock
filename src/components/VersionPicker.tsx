import { useId } from "preact/hooks";
import { Badge } from "./Badge";
import { Select } from "./Select";

export interface VersionOption {
  version: string;
  distTags: string[];
  publishedAt?: string;
  /** Display override for entries whose value is not a version (a pkg.pr.new URL). */
  label?: string;
}

/**
 * One version dropdown: mono, dist-tags in brackets, and an optional
 * `(default)` marker. Both the scan detail's single "compare against" picker
 * and the public diff's from/to pair are built on it.
 */
function VersionSelect({
  id,
  ariaLabel,
  options,
  selected,
  defaultVersion = null,
  disabledVersion = null,
  disabled,
  size,
  onChange,
}: {
  id?: string;
  ariaLabel?: string;
  options: VersionOption[];
  selected: string | null;
  defaultVersion?: string | null;
  /** The other side of a pair; a version cannot be compared against itself. */
  disabledVersion?: string | null;
  disabled?: boolean;
  size?: "sm" | "md";
  onChange: (version: string) => void;
}) {
  return (
    <Select
      id={id}
      aria-label={ariaLabel}
      value={selected ?? ""}
      size={size}
      onChange={(value) => {
        if (value && value !== selected) onChange(value);
      }}
      disabled={disabled || options.length === 0}
      mono
    >
      {!options.length ? <option value="">no published versions</option> : null}
      {options.map((option) => (
        <option
          key={option.version}
          value={option.version}
          disabled={option.version === disabledVersion}
        >
          {option.label ?? option.version}
          {option.distTags.length ? ` [${option.distTags.join(", ")}]` : ""}
          {option.version === defaultVersion ? " (default)" : ""}
        </option>
      ))}
    </Select>
  );
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
        <VersionSelect
          id={selectId}
          options={options}
          selected={selected}
          defaultVersion={defaultVersion}
          disabled={disabled}
          onChange={onChange}
        />
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

/** The public diff's from → to pair; each side excludes the other's version. */
export function VersionPairPicker({
  versions,
  fromVersion,
  toVersion,
  onChange,
}: {
  versions: VersionOption[];
  fromVersion: string;
  toVersion: string;
  onChange: (fromVersion: string, toVersion: string) => void;
}) {
  return (
    <div class="flex flex-wrap items-center gap-3">
      <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">Compare</span>
      <div class="inline-block w-auto min-w-[160px]">
        <VersionSelect
          ariaLabel="From version"
          size="sm"
          options={versions}
          selected={fromVersion}
          disabledVersion={toVersion}
          onChange={(version) => onChange(version, toVersion)}
        />
      </div>
      <span class="font-mono text-[11px] text-ink-muted" aria-hidden>
        →
      </span>
      <div class="inline-block w-auto min-w-[160px]">
        <VersionSelect
          ariaLabel="To version"
          size="sm"
          options={versions}
          selected={toVersion}
          disabledVersion={fromVersion}
          onChange={(version) => onChange(fromVersion, version)}
        />
      </div>
    </div>
  );
}
