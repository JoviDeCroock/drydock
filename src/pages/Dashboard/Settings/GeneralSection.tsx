import { useModel, useSignal } from "@preact/signals";
import type { OrganizationRole } from "../../../../server/lib/auth/roles";
import { OrganizationModel } from "../../../models/organization";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { SettingsCard } from "../../../components/Card";
import { ConfirmDialog } from "../../../components/Dialog";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { MonoDetail, Muted, SectionLabel } from "../../../components/Typography";

type Organizations = ReturnType<typeof useModel<typeof OrganizationModel.prototype>>;

export function GeneralSection({
  organizations,
  currentUserRole,
}: {
  organizations: Organizations;
  currentUserRole: OrganizationRole | null;
}) {
  const active = organizations.active.value;
  const isPersonal = active?.isPersonal ?? false;

  return (
    <SettingsCard class="flex flex-col gap-5">
      <SectionLabel as="h2">General</SectionLabel>

      {active ? (
        <div class="flex flex-col gap-1.5">
          <span class="text-[14px] font-medium text-ink">{active.name}</span>
          {/* The role is a fact about the reader, not an attention state, and the
              internal id is reference detail, so both stay in the mono line. */}
          <MonoDetail
            parts={[
              <span key="kind">{isPersonal ? "personal workspace" : "organization"}</span>,
              currentUserRole ? <span key="role">you are {currentUserRole}</span> : null,
              <span key="id" class="break-all">
                id {active.id}
              </span>,
            ]}
          />
        </div>
      ) : (
        <Muted class="text-[13px] m-0">No organization selected.</Muted>
      )}
    </SettingsCard>
  );
}

/**
 * The General tab's last card, so the one destructive action sits apart from
 * the settings above it. Only the owner of a non-personal org can delete it,
 * so the card renders only when the action is actually available.
 */
export function OrganizationDangerZone({
  organizations,
  currentUserRole,
  onDeleted,
}: {
  organizations: Organizations;
  currentUserRole: OrganizationRole | null;
  onDeleted: () => Promise<void> | void;
}) {
  const active = organizations.active.value;
  const status = organizations.status.value;
  const error = organizations.error.value;
  const deleting = status === "deleting";
  const confirming = useSignal(false);
  const confirmName = useSignal("");

  const openConfirm = () => {
    organizations.error.value = null;
    confirmName.value = "";
    confirming.value = true;
  };

  const closeConfirm = () => {
    confirming.value = false;
    confirmName.value = "";
  };

  const onConfirmDelete = async (event: Event) => {
    event.preventDefault();
    if (!active || confirmName.value !== active.name) return;
    const ok = await organizations.delete(active.id);
    if (ok) {
      closeConfirm();
      await onDeleted();
    }
  };

  if (!active || currentUserRole !== "owner" || active.isPersonal) return null;

  return (
    <SettingsCard class="flex flex-col gap-3">
      <SectionLabel as="h2">Danger zone</SectionLabel>
      <Muted class="text-[13px] m-0 max-w-[760px]">
        Deleting this organization permanently removes its members, npm and GitHub connections,
        notification recipients, and scan history. This cannot be undone.
      </Muted>
      <div>
        <Button variant="danger" onClick={openConfirm}>
          Delete organization
        </Button>
      </div>

      <ConfirmDialog
        open={confirming}
        onClose={closeConfirm}
        title={`Delete ${active.name}?`}
        description="This permanently deletes the organization and everything scoped to it. This action cannot be undone."
        busy={deleting}
        busyLabel="Deleting…"
        confirmLabel="Delete organization"
        confirmDisabled={confirmName.value !== active.name}
        form="org-delete-form"
      >
        <form id="org-delete-form" onSubmit={onConfirmDelete} class="flex flex-col gap-3">
          <Field label={`Type ${active.name} to confirm`} for="confirmOrgName">
            <Input
              id="confirmOrgName"
              type="text"
              value={confirmName.value}
              onInput={(e) => (confirmName.value = (e.target as HTMLInputElement).value)}
              disabled={deleting}
              autoComplete="off"
              spellcheck={false}
              autofocus
            />
          </Field>
          {error ? <Alert tone="critical">{error}</Alert> : null}
        </form>
      </ConfirmDialog>
    </SettingsCard>
  );
}
