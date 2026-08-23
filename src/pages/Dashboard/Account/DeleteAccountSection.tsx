import { useComputed, useSignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { sessionModel, signInMethodsModel } from "../../../models/auth";
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

  // Every account must type its email. Credential accounts also reauthenticate
  // with a password; GitHub-only accounts rely on Better Auth's fresh-session
  // check because they have no password to provide.
  const canSubmit = useComputed(() => {
    const hasPassword = signInMethodsModel.hasPassword.value;
    const passwordReady = password.value.length > 0;
    const emailMatches = confirmEmail.value.trim().toLowerCase() === email.toLowerCase();
    const isBusy = busy.value;
    return (!hasPassword || passwordReady) && emailMatches && !isBusy;
  });
  const submitDisabled = useComputed(() => !canSubmit.value);

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
    if (!canSubmit.peek()) return;
    busy.value = true;
    error.value = null;
    const pw = signInMethodsModel.hasPassword.peek() ? password.peek() : undefined;
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
      <SectionLabel as="h2">Danger zone</SectionLabel>
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
            <Button variant="secondary" size="sm" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="danger"
              size="sm"
              form="account-delete-form"
              disabled={submitDisabled}
            >
              <Show when={busy} fallback="Delete account">
                Deleting…
              </Show>
            </Button>
          </>
        }
      >
        <form id="account-delete-form" onSubmit={onSubmit} class="flex flex-col gap-4">
          <Show
            when={signInMethodsModel.hasPassword}
            fallback={
              <Alert tone="info">
                GitHub verifies this deletion through your current sign-in. If the session is no
                longer fresh, sign out, sign back in with GitHub, and retry.
              </Alert>
            }
          >
            <Field label="Confirm your password" for="account-delete-password">
              <Input
                id="account-delete-password"
                type="password"
                value={password}
                autocomplete="current-password"
                required
                disabled={busy}
                onInput={(e) => (password.value = (e.target as HTMLInputElement).value)}
              />
            </Field>
          </Show>
          <Field label={`Type ${email} to confirm`} for="account-delete-email">
            <Input
              id="account-delete-email"
              type="email"
              value={confirmEmail}
              autocomplete="off"
              spellcheck={false}
              disabled={busy}
              onInput={(e) => (confirmEmail.value = (e.target as HTMLInputElement).value)}
            />
          </Field>
          <Show when={error}>{(message) => <Alert tone="critical">{message}</Alert>}</Show>
        </form>
      </Dialog>
    </SettingsCard>
  );
}
