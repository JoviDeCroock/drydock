import { useEffect } from "preact/hooks";
import { useModel, useSignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PasswordResetModel,
  readResetToken,
} from "../../models/password-reset";
import { Alert } from "../../components/Alert";
import { Button, LinkButton } from "../../components/Button";
import { Card } from "../../components/Card";
import { Field } from "../../components/Field";
import { Input } from "../../components/Input";
import { LoadingState } from "../../components/Loading";
import { PageShell } from "../../components/PageShell";
import { Muted } from "../../components/Typography";

type LinkState = "reading" | "missing" | "ready";

export default function ResetPasswordPage() {
  const reset = useModel(PasswordResetModel);
  const linkState = useSignal<LinkState>("reading");
  const token = useSignal("");
  const password = useSignal("");
  const confirmation = useSignal("");

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
          <Alert tone="critical">
            This page needs the link from your reset email. Open it again, or request a new one.
          </Alert>
          <LinkButton href="/forgot-password" class="self-start">
            Request a new link
          </LinkButton>
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
                Link expired? <a href="/forgot-password">Request a new one</a>
              </p>
            </>
          }
        >
          <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">Password set</h1>
          <Alert tone="ok">Your new password is saved and every device was signed out.</Alert>
          <LinkButton href="/login" class="self-start">
            Go to sign in
          </LinkButton>
        </Show>
      </Card>
    </PageShell>
  );
}
