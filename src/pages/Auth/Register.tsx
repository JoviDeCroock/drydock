import { useEffect } from "preact/hooks";
import { useSignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { useLocation } from "preact-iso";
import { normalizeAuthReturnTo } from "../../lib/auth-return";
import { sessionModel } from "../../models/auth";
import { errorMessage } from "../../models/api";
import { Alert } from "../../components/Alert";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Field } from "../../components/Field";
import { Input } from "../../components/Input";
import { PageShell } from "../../components/PageShell";
import { Muted } from "../../components/Typography";
import { SocialSignIn } from "./SocialSignIn";

export default function RegisterPage() {
  const location = useLocation();
  const name = useSignal("");
  const email = useSignal("");
  const password = useSignal("");
  // A failed or cancelled OAuth redirect lands back here with ?error=…
  // (the errorCallbackURL passed when the redirect started).
  const error = useSignal<string | null>(
    location.query.error
      ? "GitHub sign-in didn't complete. Try again, or create an account with email."
      : null,
  );
  const loading = useSignal(false);
  const verificationSentTo = useSignal<string | null>(null);
  const resending = useSignal(false);
  const resent = useSignal(false);
  const returnTo = normalizeAuthReturnTo(location.query.returnTo);
  const signInHref =
    returnTo === "/dashboard" ? "/login" : `/login?returnTo=${encodeURIComponent(returnTo)}`;

  useEffect(() => {
    let cancelled = false;
    void sessionModel.load().then((session) => {
      if (cancelled) return;
      if (session?.user) location.route(returnTo, true);
    });
    return () => {
      cancelled = true;
    };
  }, [returnTo]);

  const onSubmit = async (event: Event) => {
    event.preventDefault();
    const submittedName = name.value.trim();
    const submittedEmail = email.value.trim();
    const submittedPassword = password.value;
    loading.value = true;
    error.value = null;
    try {
      await sessionModel.signUp(submittedName, submittedEmail, submittedPassword, returnTo);
      // When verification is enforced sign-up does not start a session; when it
      // is not (no email transport configured) the user is already signed in.
      const session = await sessionModel.load();
      if (session?.user) {
        location.route(returnTo, true);
        return;
      }
      verificationSentTo.value = submittedEmail;
    } catch (err) {
      error.value = errorMessage(err);
    } finally {
      loading.value = false;
    }
  };

  const onResend = async () => {
    const target = verificationSentTo.value;
    if (!target) return;
    resending.value = true;
    resent.value = false;
    error.value = null;
    try {
      await sessionModel.resendVerification(target, returnTo);
      resent.value = true;
    } catch (err) {
      error.value = errorMessage(err);
    } finally {
      resending.value = false;
    }
  };

  if (verificationSentTo.value) {
    return (
      <PageShell width="narrow">
        <Card class="flex flex-col gap-4">
          <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">Check your email</h1>
          <Alert tone="info">
            We sent a verification link to {verificationSentTo.value}. Open it to activate your
            account.
          </Alert>
          <Muted class="text-[13px] m-0">
            The link expires in 24 hours. Check your spam folder if it doesn't arrive.
          </Muted>

          <Show when={error}>{(message) => <Alert tone="critical">{message}</Alert>}</Show>
          <Show when={resent}>
            <Alert tone="ok">We sent another verification link.</Alert>
          </Show>

          <Button variant="secondary" disabled={resending} onClick={onResend}>
            <Show when={resending} fallback="Resend verification email">
              Resending…
            </Show>
          </Button>

          <p class="text-[13px] text-ink-muted m-0">
            Already verified? <a href={signInHref}>Sign in</a>
          </p>
        </Card>
      </PageShell>
    );
  }

  return (
    <PageShell width="narrow">
      <Card class="flex flex-col gap-4">
        <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">Create account</h1>
        <Muted class="text-[13px] m-0">
          Create a workspace, connect npm or a GitHub gate, and review held releases before they go
          live.
        </Muted>

        <SocialSignIn
          returnTo={returnTo}
          errorPath="/register"
          onError={(message) => (error.value = message)}
        />

        <form class="flex flex-col gap-4 mt-2" onSubmit={onSubmit}>
          <Field label="Name" for="register-name">
            <Input
              id="register-name"
              type="text"
              value={name}
              autocomplete="name"
              required
              onInput={(e) => (name.value = (e.target as HTMLInputElement).value)}
            />
          </Field>
          <Field label="Email" for="register-email">
            <Input
              id="register-email"
              type="email"
              value={email}
              autocomplete="email"
              required
              onInput={(e) => (email.value = (e.target as HTMLInputElement).value)}
            />
          </Field>
          <Field label="Password" for="register-password">
            <Input
              id="register-password"
              type="password"
              value={password}
              autocomplete="new-password"
              minlength={12}
              required
              onInput={(e) => (password.value = (e.target as HTMLInputElement).value)}
            />
          </Field>

          <Show when={error}>{(message) => <Alert tone="critical">{message}</Alert>}</Show>

          <Button type="submit" disabled={loading}>
            <Show when={loading} fallback="Create account">
              Creating…
            </Show>
          </Button>
        </form>

        <p class="text-[13px] text-ink-muted m-0">
          Already have an account? <a href={signInHref}>Sign in</a>
        </p>
      </Card>
    </PageShell>
  );
}
