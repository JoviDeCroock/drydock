import type { JSX } from "preact";
import { useSignal } from "@preact/signals";
import type { Organization } from "../models/organization";
import { Alert } from "./Alert";
import { Button } from "./Button";
import { Input } from "./Input";
import { cn } from "./cn";

interface OrgSwitcherProps {
  organizations: Organization[];
  activeOrganizationId: string | null;
  busy?: boolean;
  error?: string | null;
  onActivate: (id: string) => Promise<unknown> | unknown;
  onCreate: (name: string) => Promise<unknown> | unknown;
}

export function OrgSwitcher({
  organizations,
  activeOrganizationId,
  busy,
  error,
  onActivate,
  onCreate,
}: OrgSwitcherProps) {
  const creating = useSignal(false);
  const draftName = useSignal("");

  const handleChange: JSX.GenericEventHandler<HTMLSelectElement> = (event) => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (value && value !== activeOrganizationId) void onActivate(value);
  };

  const submitCreate = async (event: Event) => {
    event.preventDefault();
    const name = draftName.value.trim();
    if (!name) return;
    await onCreate(name);
    draftName.value = "";
    creating.value = false;
  };

  return (
    <div class="flex flex-col gap-2">
      <div class="flex flex-wrap items-center gap-3">
        <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">
          Organization
        </span>
        <select
          value={activeOrganizationId ?? ""}
          onChange={handleChange}
          disabled={busy || organizations.length === 0}
          class={cn(
            "bg-bg border border-border rounded-md text-[13px] text-ink px-3 py-2 outline-none",
            "focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-soft)]",
            "disabled:opacity-60 disabled:cursor-not-allowed",
            "font-mono min-w-[200px]",
          )}
        >
          {organizations.length === 0 ? <option value="">no organizations</option> : null}
          {organizations.map((org) => (
            <option key={org.id} value={org.id}>
              {org.name}
              {org.isPersonal ? " (personal)" : ""}
              {org.npmConnectionConfigured ? "" : " — no npm token"}
            </option>
          ))}
        </select>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => (creating.value = !creating.value)}
          disabled={busy}
          class="shrink-0"
        >
          {creating.value ? "Cancel" : "New organization"}
        </Button>
      </div>

      {creating.value ? (
        <form class="flex flex-wrap items-center gap-2" onSubmit={submitCreate}>
          <Input
            type="text"
            value={draftName.value}
            placeholder="acme-frontend"
            onInput={(e) => (draftName.value = (e.target as HTMLInputElement).value)}
            disabled={busy}
            autoComplete="off"
            spellcheck={false}
            class="min-w-[220px]"
          />
          <Button type="submit" size="sm" disabled={busy || !draftName.value.trim()}>
            {busy ? "Creating…" : "Create"}
          </Button>
        </form>
      ) : null}

      {error ? <Alert tone="critical">{error}</Alert> : null}
    </div>
  );
}
