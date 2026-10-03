import { useComputed, useModel } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { authConfigModel, sessionModel } from "../../../models/auth";
import { PasswordResetModel } from "../../../models/password-reset";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { Muted } from "../../../components/Typography";

/**
 * Two-factor's stand-in for an account with no `credential` row (a GitHub
 * sign-up): every two-factor endpoint confirms with a password, so the account
 * needs one first. It is added through the emailed reset link, never from this
 * session alone, so a stolen session cookie cannot mint a password.
 */
export function SetPasswordPrompt() {
  const reset = useModel(PasswordResetModel);
  const email = useComputed(() => sessionModel.user.value?.email ?? "");

  const onSend = async () => {
    const target = email.peek();
    if (target) await reset.requestLink(target);
  };

  return (
    <Show
      when={authConfigModel.passwordReset}
      fallback={
        <Show
          when={authConfigModel.loaded}
          fallback={
            <Alert tone="warn">
              Couldn't check how this account can add a password. Reload the page to try again.
            </Alert>
          }
        >
          <Alert tone="info">
            This account signs in with GitHub and has no Drydock password for two-factor to confirm,
            and this deployment can't send the email that adds one. An organization that requires
            Drydock two-factor for release decisions can't be satisfied by this account.
          </Alert>
        </Show>
      }
    >
      <div class="flex flex-col gap-3">
        <Muted class="text-[13px] m-0 max-w-[760px]">
          This account signs in with GitHub. Two-factor confirms each change with a Drydock
          password, so add one first through a link sent to <span class="text-ink">{email}</span>.
        </Muted>
        <Show
          when={reset.sentTo}
          fallback={
            <div>
              <Button onClick={onSend} disabled={reset.busy}>
                <Show when={reset.busy} fallback="Email me a link to set a password">
                  Sending…
                </Show>
              </Button>
            </div>
          }
        >
          <Alert tone="ok">
            Check your inbox: the link expires in 1 hour, and once the password is set, sign back in
            and enable two-factor here.
          </Alert>
        </Show>
        <Show when={reset.error}>{(message) => <Alert tone="critical">{message}</Alert>}</Show>
      </div>
    </Show>
  );
}
