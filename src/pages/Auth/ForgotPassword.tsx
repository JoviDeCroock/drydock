import { useEffect } from "preact/hooks";
import { useComputed, useModel, useSignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { useLocation } from "preact-iso";
import { authConfigModel } from "../../models/auth";
import { PasswordResetModel } from "../../models/password-reset";
import { Alert } from "../../components/Alert";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Field } from "../../components/Field";
import { Input } from "../../components/Input";
import { PageShell } from "../../components/PageShell";
import { Muted } from "../../components/Typography";
import { authPageHref } from "./auth-links";

export default function ForgotPasswordPage() {
  const location = useLocation();
  const signInHref = authPageHref("/login", location.query.returnTo);
  const reset = useModel(PasswordResetModel);
  const email = useSignal("");
  // The form stays usable while the config loads, or if the lookup failed; it
  // is replaced only once the deployment has said it cannot mail a link.
  const unavailable = useComputed(
    () => authConfigModel.loaded.value && !authConfigModel.passwordReset.value,
  );

  useEffect(() => {
    void authConfigModel.load();
  }, []);

  const onSubmit = async (event: Event) => {
    event.preventDefault();
    const target = email.value.trim();
    if (!target) return;
    await reset.requestLink(target, location.query.returnTo);
  };

  return (
    <PageShell width="narrow">
      <Card class="flex flex-col gap-4">
        <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">Reset your password</h1>

        <Show
          when={unavailable}
          fallback={
            <Show
              when={reset.sentTo}
              fallback={
                <>
                  <Muted class="text-[13px] m-0">
                    Enter the email you sign in with. We'll send a link to choose a new password. If
                    you signed up with GitHub, sign in with GitHub and add a password from Account
                    settings instead.
                  </Muted>
                  <form class="flex flex-col gap-4 mt-2" onSubmit={onSubmit}>
                    <Field label="Email" for="forgot-email">
                      <Input
                        id="forgot-email"
                        type="email"
                        value={email}
                        autocomplete="email"
                        required
                        onInput={(e) => (email.value = (e.target as HTMLInputElement).value)}
                      />
                    </Field>

                    <Show when={reset.error}>
                      {(message) => <Alert tone="critical">{message}</Alert>}
                    </Show>

                    <Button type="submit" disabled={reset.busy}>
                      <Show when={reset.busy} fallback="Send reset link">
                        Sending…
                      </Show>
                    </Button>
                  </form>
                </>
              }
            >
              {(sentTo) => (
                <Alert tone="ok">
                  If an account uses {sentTo}, a reset link is on its way. It expires in 1 hour.
                </Alert>
              )}
            </Show>
          }
        >
          <Alert tone="warn">
            Password reset isn't available here because this deployment can't send email. Ask
            whoever runs it to help you back in.
          </Alert>
        </Show>

        <p class="text-[13px] text-ink-muted m-0">
          <a href={signInHref}>Back to sign in</a>
        </p>
      </Card>
    </PageShell>
  );
}
