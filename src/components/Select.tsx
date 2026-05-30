import type { ComponentChildren } from "preact";

export function Select({
  id,
  value,
  disabled,
  onChange,
  children,
}: {
  id?: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  children: ComponentChildren;
}) {
  return (
    <div class="relative inline-block w-full">
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange((event.currentTarget as HTMLSelectElement).value)}
        class="appearance-none w-full bg-bg border border-border rounded-md text-[13px] text-ink pl-3 pr-9 py-2 outline-none transition-[border-color,box-shadow] duration-150 ease-out focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-soft)] disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {children}
      </select>
      <span
        aria-hidden="true"
        class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-ink-muted"
      >
        ▾
      </span>
    </div>
  );
}
