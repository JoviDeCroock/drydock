import { useSignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { sessionModel } from "../../../models/auth";
import { errorMessage } from "../../../models/api";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { SettingsCard } from "../../../components/Card";
import { Dialog } from "../../../components/Dialog";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { Muted, SectionLabel } from "../../../components/Typography";

export function DeleteAccountSection({ onDeleted }: { onDeleted: () => void }) {
  const email = sessionModel.user.value?.email ?? "";
  const confirming = useSignal(false);
  const password = useSignal("");
  const confirmEmail = useSignal("");
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);

  // Require both reauth (password) and the typed email, so the irreversible
  // action can't fire from a stray click or an autofilled field alone.
  const emailMatches = confirmEmail.value.trim().toLowerCase() === email.toLowerCase();
  const canSubmit = password.value.length > 0 && emailMatches && !busy.value;

  const open = () => {
    error.value = null;
    password.value = "";
    confirmEmail.value = "";
    confirming.value = true;
  };

  const close = () => {
    if (busy.value) return;
    confirming.value = false;
  };

  const onSubmit = async (event: Event) => {
    event.preventDefault();
    if (!canSubmit) return;
    busy.value = true;
    error.value = null;
    const pw = password.value; // read before the await so the lint reactive guard is satisfied
    try {
      await sessionModel.deleteAccount(pw);
      onDeleted();
    } catch (err) {
      error.value = errorMessage(err);
      busy.value = false;
    }
  };

  return (
    <SettingsCard class="flex flex-col gap-3">
      <SectionLabel>Danger zone</SectionLabel>
      <Muted class="text-[13px] m-0 max-w-[760px]">
        Deleting your account permanently removes your personal workspace, every organization you
        solely own, and your two-factor enrollment, and signs you out everywhere. This cannot be
        undone. If you own an organization with other members, hand it off or delete it first.
      </Muted>
      <div>
        <Button variant="danger" size="sm" onClick={open}>
          Delete account
        </Button>
      </div>

      <Dialog
        open={confirming.value}
        onClose={close}
        title="Delete your account?"
        description="This permanently deletes your account and everything you solely own. This action cannot be undone."
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={close} disabled={busy.value}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="danger"
              size="sm"
              form="account-delete-form"
              disabled={!canSubmit}
            >
              <Show when={busy} fallback="Delete account">
                Deleting…
              </Show>
            </Button>
          </>
        }
      >
        <form id="account-delete-form" onSubmit={onSubmit} class="flex flex-col gap-4">
          <Field label="Confirm your password" for="account-delete-password">
            <Input
              id="account-delete-password"
              type="password"
              value={password.value}
              autocomplete="current-password"
              required
              disabled={busy.value}
              onInput={(e) => (password.value = (e.target as HTMLInputElement).value)}
            />
          </Field>
          <Field label={`Type ${email} to confirm`} for="account-delete-email">
            <Input
              id="account-delete-email"
              type="email"
              value={confirmEmail.value}
              autocomplete="off"
              spellcheck={false}
              disabled={busy.value}
              onInput={(e) => (confirmEmail.value = (e.target as HTMLInputElement).value)}
            />
          </Field>
          <Show when={error}>{(message) => <Alert tone="critical">{message}</Alert>}</Show>
        </form>
      </Dialog>
    </SettingsCard>
  );
}
