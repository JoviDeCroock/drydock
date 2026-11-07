import { useEffect } from "preact/hooks";
import { useComputed, useModel, useSignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { useLocation } from "preact-iso";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PasswordResetModel,
  readResetToken,
} from "../../models/password-reset";
import { authConfigModel } from "../../models/auth";
import { Alert } from "../../components/Alert";
import { Button, LinkButton } from "../../components/Button";
import { Card } from "../../components/Card";
import { Field } from "../../components/Field";
import { Input } from "../../components/Input";
import { LoadingState } from "../../components/Loading";
import { PageShell } from "../../components/PageShell";
import { Muted } from "../../components/Typography";
import { authPageHref } from "./auth-links";

type LinkState = "reading" | "missing" | "ready";

export default function ResetPasswordPage() {
  const location = useLocation();
  const signInHref = authPageHref("/login", location.query.returnTo);
  const requestLinkHref = authPageHref("/forgot-password", location.query.returnTo);
  const reset = useModel(PasswordResetModel);
  const linkState = useSignal<LinkState>("reading");
  const token = useSignal("");
  const password = useSignal("");
  const confirmation = useSignal("");
  const resetUnavailable = useComputed(
    () => authConfigModel.loaded.value && !authConfigModel.passwordReset.value,
  );

  useEffect(() => {
    void authConfigModel.load();
  }, []);

  useEffect(() => {
    const fromLink = readResetToken(window.location.hash);
    // Keep the token in memory only: out of the address bar, history, and any
    // later copy of this URL.
    if (window.location.hash) {
      history.replaceState(history.state, "", window.location.pathname + window.location.search);
    }
    token.value = fromLink ?? "";
    linkState.value = fromLink ? "ready" : "missing";
  }, []);

  const onSubmit = async (event: Event) => {
    event.preventDefault();
    const submitted = { token: token.value, password: password.value, again: confirmation.value };
    await reset.complete(submitted.token, submitted.password, submitted.again);
  };

  if (linkState.value === "reading") {
    return (
      <PageShell width="narrow">
        <LoadingState title="Opening your reset link" detail="reading link" />
      </PageShell>
    );
  }

  if (linkState.value === "missing") {
    return (
      <PageShell width="narrow">
        <Card class="flex flex-col gap-4">
          <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">Set a new password</h1>
          {/* Offering a new link only makes sense where the deployment can mail
              one; while the config loads, the offer stays, as on the request page. */}
          <Show
            when={resetUnavailable}
            fallback={
              <>
                <Muted class="text-[13px] m-0">
                  This page needs the link from your reset email. Open that link again, or request a
                  new one.
                </Muted>
                <LinkButton href={requestLinkHref}>Request a new link</LinkButton>
              </>
            }
          >
            <Muted class="text-[13px] m-0">
              This page needs the link from a reset email, and this deployment can't send email. Ask
              whoever runs it to help you back in.
            </Muted>
          </Show>
          <p class="text-[13px] text-ink-muted m-0">
            <a href={signInHref}>Back to sign in</a>
          </p>
        </Card>
      </PageShell>
    );
  }

  return (
    <PageShell width="narrow">
      <Card class="flex flex-col gap-4">
        <Show
          when={reset.done}
          fallback={
            <>
              <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">Set a new password</h1>
              <Muted class="text-[13px] m-0">
                Use {PASSWORD_MIN_LENGTH} to {PASSWORD_MAX_LENGTH} characters. Saving it signs this
                account out on every device.
              </Muted>

              <form class="flex flex-col gap-4 mt-2" onSubmit={onSubmit}>
                <Field label="New password" for="reset-password">
                  <Input
                    id="reset-password"
                    type="password"
                    value={password}
                    autocomplete="new-password"
                    minlength={PASSWORD_MIN_LENGTH}
                    maxlength={PASSWORD_MAX_LENGTH}
                    autoFocus
                    required
                    onInput={(e) => (password.value = (e.target as HTMLInputElement).value)}
                  />
                </Field>
                <Field label="Confirm new password" for="reset-password-confirm">
                  <Input
                    id="reset-password-confirm"
                    type="password"
                    value={confirmation}
                    autocomplete="new-password"
                    minlength={PASSWORD_MIN_LENGTH}
                    maxlength={PASSWORD_MAX_LENGTH}
                    required
                    onInput={(e) => (confirmation.value = (e.target as HTMLInputElement).value)}
                  />
                </Field>

                <Show when={reset.error}>
                  {(message) => <Alert tone="critical">{message}</Alert>}
                </Show>

                <Button type="submit" disabled={reset.busy}>
                  <Show when={reset.busy} fallback="Set password">
                    Saving…
                  </Show>
                </Button>
              </form>

              <p class="text-[13px] text-ink-muted m-0">
                Link expired? <a href={requestLinkHref}>Request a new one</a>
              </p>
            </>
          }
        >
          <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">Password set</h1>
          <Muted class="text-[13px] m-0">
            Your new password is saved, and every device was signed out.
          </Muted>
          <LinkButton href={signInHref}>Go to sign in</LinkButton>
        </Show>
      </Card>
    </PageShell>
  );
}
