import { useModel } from "@preact/signals";
import {
  NotificationRecipientsModel,
  type NotificationRecipient,
} from "../../../models/notification-recipients";
import {
  Alert,
  Badge,
  Button,
  CollapsibleCard,
  Field,
  Input,
  LoadingLine,
  Muted,
} from "../../../components";

export function NotificationRecipientsSection({
  recipients,
  organizationId,
  canManage,
  fallbackEmail,
}: {
  recipients: ReturnType<typeof useModel<typeof NotificationRecipientsModel.prototype>>;
  organizationId: string | null;
  canManage: boolean;
  fallbackEmail?: string;
}) {
  const list = recipients.recipients.value;
  const status = recipients.status.value;
  const busy = recipients.busy.value;
  const loaded = recipients.loaded.value;
  const error = recipients.error.value;
  const draft = recipients.draftEmail.value;

  const onAdd = async (event: Event) => {
    event.preventDefault();
    if (organizationId) await recipients.add(organizationId);
  };

  return (
    <CollapsibleCard
      title="notification recipients"
      aside={<Badge tone="info">{list.length} configured</Badge>}
    >
      <div class="p-5 flex flex-col gap-5">
        <Muted class="text-[13px] m-0 max-w-[760px]">
          Choose who gets emailed when an auto-discovered scan finishes or a release gate needs a
          review decision. Add a shared inbox or teammates. When this list is empty, Drydock emails
          the organization owner.
        </Muted>

        {!loaded ? (
          <LoadingLine class="border-y border-border py-3">loading recipients</LoadingLine>
        ) : list.length > 0 ? (
          <ul class="flex flex-col gap-2 m-0 p-0 list-none border-y border-border py-3">
            {list.map((recipient: NotificationRecipient) => (
              <li key={recipient.id} class="flex items-center justify-between gap-3">
                <code class="text-[13px] text-ink-muted break-all">{recipient.email}</code>
                {canManage ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      organizationId && void recipients.remove(organizationId, recipient.id)
                    }
                    disabled={busy || !organizationId}
                    class="shrink-0"
                  >
                    {status === "removing" ? "Removing…" : "Remove"}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <Muted class="text-[13px] m-0 border-y border-border py-3">
            No recipients configured — notifications go to{" "}
            {fallbackEmail ?? "the organization owner"}.
          </Muted>
        )}

        {canManage ? (
          <form
            class="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto] gap-3 items-end"
            onSubmit={onAdd}
          >
            <Field label="Add recipient email" for="recipientEmail">
              <Input
                id="recipientEmail"
                type="email"
                value={draft}
                placeholder="security@example.com"
                onInput={(e) =>
                  (recipients.draftEmail.value = (e.target as HTMLInputElement).value)
                }
                disabled={busy || !organizationId}
                autoComplete="off"
                spellcheck={false}
              />
            </Field>
            <Button
              type="submit"
              disabled={busy || !draft.trim() || !organizationId}
              class="shrink-0"
            >
              {status === "adding" ? "Adding…" : "Add recipient"}
            </Button>
          </form>
        ) : null}

        {error ? <Alert tone="critical">{error}</Alert> : null}
      </div>
    </CollapsibleCard>
  );
}
