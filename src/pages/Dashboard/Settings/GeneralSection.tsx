import { useModel, useSignal } from "@preact/signals";
import type { OrganizationRole } from "../../../../server/lib/roles";
import { OrganizationModel } from "../../../models/organization";
import { Alert } from "../../../components/Alert";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { SettingsCard } from "../../../components/Card";
import { Dialog } from "../../../components/Dialog";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { MonoDetail, Muted, SectionLabel } from "../../../components/Typography";

export function GeneralSection({
  organizations,
  currentUserRole,
  onDeleted,
}: {
  organizations: ReturnType<typeof useModel<typeof OrganizationModel.prototype>>;
  currentUserRole: OrganizationRole | null;
  onDeleted: () => Promise<void> | void;
}) {
  const active = organizations.active.value;
  const status = organizations.status.value;
  const error = organizations.error.value;
  const deleting = status === "deleting";
  const confirming = useSignal(false);
  const confirmName = useSignal("");

  const isOwner = currentUserRole === "owner";
  const isPersonal = active?.isPersonal ?? false;
  const canDelete = Boolean(active) && isOwner && !isPersonal;

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

  return (
    <SettingsCard class="flex flex-col gap-5">
      <SectionLabel>General</SectionLabel>

      {active ? (
        <div class="flex flex-col gap-1.5">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-[14px] font-medium text-ink">{active.name}</span>
            {currentUserRole ? (
              <Badge tone={currentUserRole === "owner" ? "info" : "neutral"}>
                {currentUserRole}
              </Badge>
            ) : null}
            {isPersonal ? <Badge tone="neutral">personal</Badge> : null}
          </div>
          <MonoDetail
            parts={[
              <span key="id">{active.id}</span>,
              isPersonal ? <span key="personal">personal workspace</span> : null,
            ]}
          />
        </div>
      ) : (
        <Muted class="text-[13px] m-0">No organization selected.</Muted>
      )}

      {/* Only the owner of a non-personal org can delete it, so the Danger zone
          is shown only when the action is actually available. */}
      {canDelete ? (
        <div class="flex flex-col gap-3">
          <SectionLabel>Danger zone</SectionLabel>
          <Muted class="text-[13px] m-0 max-w-[760px]">
            Deleting this organization permanently removes its members, npm and GitHub connections,
            notification recipients, and scan history. This cannot be undone.
          </Muted>
          <div>
            <Button variant="danger" size="sm" onClick={openConfirm}>
              Delete organization
            </Button>
          </div>
        </div>
      ) : null}

      {active ? (
        <Dialog
          open={confirming.value}
          onClose={closeConfirm}
          title={`Delete ${active.name}?`}
          description="This permanently deletes the organization and everything scoped to it. This action cannot be undone."
          footer={
            <>
              <Button variant="secondary" size="sm" onClick={closeConfirm} disabled={deleting}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="danger"
                size="sm"
                form="org-delete-form"
                disabled={deleting || confirmName.value !== active.name}
              >
                {deleting ? "Deleting…" : "Delete organization"}
              </Button>
            </>
          }
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
        </Dialog>
      ) : null}
    </SettingsCard>
  );
}
