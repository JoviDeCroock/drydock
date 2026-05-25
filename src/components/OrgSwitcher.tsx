import { useSignal } from "@preact/signals";
import type { Organization } from "../models/organization";
import { Alert } from "./Alert";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { Field } from "./Field";
import { Input } from "./Input";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "./Menu";
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

  const active = organizations.find((org) => org.id === activeOrganizationId);
  const triggerLabel = active
    ? active.name
    : organizations.length === 0
      ? "no organizations"
      : "select organization";

  const openCreate = () => {
    draftName.value = "";
    creating.value = true;
  };

  const closeCreate = () => {
    creating.value = false;
    draftName.value = "";
  };

  const submitCreate = async (event: Event) => {
    event.preventDefault();
    const name = draftName.value.trim();
    if (!name) return;
    await onCreate(name);
    closeCreate();
  };

  return (
    <div class="relative">
      <Menu
        align="end"
        disabled={busy}
        triggerAriaLabel="Switch organization"
        triggerClass={cn(
          "inline-flex items-center gap-2 bg-surface border border-border rounded-md px-3 py-1.5",
          "text-[13px] text-ink font-mono transition-colors duration-150",
          "hover:border-border-strong",
        )}
        trigger={() => (
          <>
            <span class="truncate max-w-[180px]">{triggerLabel}</span>
            {active?.isPersonal ? (
              <span class="text-ink-subtle text-[11px]">(personal)</span>
            ) : null}
            <span class="text-ink-subtle text-[10px] leading-none ml-1">▾</span>
          </>
        )}
        panelClass="min-w-[240px]"
      >
        {organizations.length === 0 ? (
          <MenuLabel>no organizations</MenuLabel>
        ) : (
          organizations.map((org) => (
            <MenuItem
              key={org.id}
              active={org.id === activeOrganizationId}
              onSelect={() => {
                if (org.id !== activeOrganizationId) void onActivate(org.id);
              }}
            >
              <span>{org.name}</span>
              {org.isPersonal ? <span class="text-ink-subtle"> (personal)</span> : null}
            </MenuItem>
          ))
        )}
        <MenuSeparator />
        <MenuItem tone="accent" onSelect={openCreate} disabled={busy}>
          + New organization
        </MenuItem>
      </Menu>

      {error ? (
        <div class="absolute right-0 top-full mt-2 z-10 w-[280px]">
          <Alert tone="critical">{error}</Alert>
        </div>
      ) : null}

      <Dialog
        open={creating.value}
        onClose={closeCreate}
        title="New organization"
        description="Create a workspace for a team or product. You can add an npm token afterwards."
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={closeCreate} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              form="org-create-form"
              disabled={busy || !draftName.value.trim()}
            >
              {busy ? "Creating…" : "Create"}
            </Button>
          </>
        }
      >
        <form id="org-create-form" onSubmit={submitCreate} class="flex flex-col gap-3">
          <Field label="Name" for="orgName">
            <Input
              id="orgName"
              type="text"
              value={draftName.value}
              placeholder="acme-frontend"
              onInput={(e) => (draftName.value = (e.target as HTMLInputElement).value)}
              disabled={busy}
              autoComplete="off"
              spellcheck={false}
              autofocus
            />
          </Field>
        </form>
      </Dialog>
    </div>
  );
}
