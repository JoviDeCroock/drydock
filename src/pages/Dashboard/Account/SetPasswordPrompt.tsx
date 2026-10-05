import { useComputed, useModel, useSignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { errorMessage } from "../../../models/api";
import { authConfigModel, sessionModel } from "../../../models/auth";
import { PasswordResetModel } from "../../../models/password-reset";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { Muted } from "../../../components/Typography";

/**
 * Two-factor's stand-in for an account with no `credential` row (a GitHub
 * sign-up): every two-factor endpoint confirms with a password, so the account
 * needs one first. It is added through the emailed reset link, never from this
 * session alone, so a stolen session cookie cannot mint a password. The server
 * mails that first link only to a verified address, so an unverified account
 * is sent to verify instead of to a button that would silently send nothing.
 */
export function SetPasswordPrompt() {
  const reset = useModel(PasswordResetModel);
  const email = useComputed(() => sessionModel.user.value?.email ?? "");
  const unverified = useComputed(() => sessionModel.user.value?.emailVerified === false);
  const verifying = useSignal(false);
  const verifySent = useSignal(false);
  const verifyError = useSignal<string | null>(null);

  const onSend = async () => {
    const target = email.peek();
    if (target) await reset.requestLink(target);
  };

  const onVerify = async () => {
    const target = email.peek();
    if (!target || verifying.peek()) return;
    verifying.value = true;
    verifyError.value = null;
    try {
      await sessionModel.resendVerification(target, "/dashboard/account");
      verifySent.value = true;
    } catch (err) {
      verifyError.value = errorMessage(err);
    } finally {
      verifying.value = false;
    }
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
      <Show
        when={unverified}
        fallback={
          <div class="flex flex-col gap-3">
            <Muted class="text-[13px] m-0 max-w-[760px]">
              This account signs in with GitHub. Two-factor confirms each change with a Drydock
              password, so add one first through a link sent to{" "}
              <span class="text-ink">{email}</span>.
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
                Check your inbox: the link expires in 1 hour, and once the password is set, sign
                back in and enable two-factor here.
              </Alert>
            </Show>
            <Show when={reset.error}>{(message) => <Alert tone="critical">{message}</Alert>}</Show>
          </div>
        }
      >
        <div class="flex flex-col gap-3">
          <Muted class="text-[13px] m-0 max-w-[760px]">
            This account signs in with GitHub. Two-factor confirms each change with a Drydock
            password, and a password is only added through a link sent to a verified address. Verify{" "}
            <span class="text-ink">{email}</span> first, then come back here.
          </Muted>
          <Show
            when={verifySent}
            fallback={
              <div>
                <Button onClick={onVerify} disabled={verifying}>
                  <Show when={verifying} fallback="Email me a verification link">
                    Sending…
                  </Show>
                </Button>
              </div>
            }
          >
            <Alert tone="ok">
              Check your inbox for the verification link, then set a password here.
            </Alert>
          </Show>
          <Show when={verifyError}>{(message) => <Alert tone="critical">{message}</Alert>}</Show>
        </div>
      </Show>
    </Show>
  );
}
