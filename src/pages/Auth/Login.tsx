import { useEffect } from "preact/hooks";
import { useSignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { useLocation } from "preact-iso";
import { normalizeAuthReturnTo } from "../../lib/auth-return";
import { AuthError, sessionModel } from "../../models/auth";
import { errorMessage } from "../../models/api";
import { Alert } from "../../components/Alert";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Field } from "../../components/Field";
import { Input } from "../../components/Input";
import { PageShell } from "../../components/PageShell";
import { Eyebrow, Muted } from "../../components/Typography";
import { SocialSignIn } from "./SocialSignIn";

export default function LoginPage() {
  const location = useLocation();
  const email = useSignal("");
  const password = useSignal("");
  const code = useSignal("");
  const useBackup = useSignal(false);
  const step = useSignal<"credentials" | "twoFactor">("credentials");
  // A failed or cancelled OAuth redirect lands back here with ?error=…
  // (the errorCallbackURL passed when the redirect started).
  const error = useSignal<string | null>(
    location.query.error
      ? "GitHub sign-in didn't complete. Try again, or use your email and password."
      : null,
  );
  const loading = useSignal(false);
  const needsVerificationFor = useSignal<string | null>(null);
  const resending = useSignal(false);
  const resent = useSignal(false);
  const returnTo = normalizeAuthReturnTo(location.query.returnTo);
  const registerHref =
    returnTo === "/dashboard" ? "/register" : `/register?returnTo=${encodeURIComponent(returnTo)}`;

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
    const submittedEmail = email.value.trim();
    const submittedPassword = password.value;
    loading.value = true;
    error.value = null;
    try {
      const { twoFactorRequired } = await sessionModel.signIn(
        submittedEmail,
        submittedPassword,
        returnTo,
      );
      if (twoFactorRequired) {
        step.value = "twoFactor";
        return;
      }
      location.route(returnTo, true);
    } catch (err) {
      // The server re-sends a verification link on an unverified sign-in, so
      // steer the user to their inbox instead of showing a generic failure.
      if (err instanceof AuthError && err.code === "EMAIL_NOT_VERIFIED") {
        needsVerificationFor.value = submittedEmail;
        resent.value = true;
      } else {
        error.value = errorMessage(err);
      }
    } finally {
      loading.value = false;
    }
  };

  const onResend = async () => {
    const target = needsVerificationFor.value;
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

  const onVerify = async (event: Event) => {
    event.preventDefault();
    const submittedCode = code.value.trim();
    const backup = useBackup.value;
    loading.value = true;
    error.value = null;
    try {
      await sessionModel.completeTwoFactorSignIn(submittedCode, { backup });
      location.route(returnTo, true);
    } catch (err) {
      error.value = errorMessage(err);
    } finally {
      loading.value = false;
    }
  };

  if (needsVerificationFor.value) {
    return (
      <PageShell width="narrow">
        <Card class="flex flex-col gap-4">
          <Eyebrow>Verify your email</Eyebrow>
          <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">One more step</h1>
          <Alert tone="info">
            Your email isn't verified yet. We sent a verification link to{" "}
            {needsVerificationFor.value}.
          </Alert>
          <Muted class="text-[13px] m-0">
            Open the link to finish signing in. It expires in 24 hours.
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
            <a href="/login" onClick={() => (needsVerificationFor.value = null)}>
              Back to sign in
            </a>
          </p>
        </Card>
      </PageShell>
    );
  }

  if (step.value === "twoFactor") {
    return (
      <PageShell width="narrow">
        <Card class="flex flex-col gap-4">
          <Eyebrow>Two-factor authentication</Eyebrow>
          <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">Verify it's you</h1>
          <Muted class="text-[13px] m-0">
            <Show when={useBackup} fallback="Enter the 6-digit code from your authenticator app.">
              Enter one of your saved backup recovery codes.
            </Show>
          </Muted>

          <form class="flex flex-col gap-4 mt-2" onSubmit={onVerify}>
            <Field
              label={useBackup.value ? "Backup code" : "Authentication code"}
              for="twofactor-code"
            >
              <Input
                id="twofactor-code"
                type="text"
                value={code}
                inputmode={useBackup.value ? "text" : "numeric"}
                autocomplete="one-time-code"
                autoFocus
                required
                onInput={(e) => (code.value = (e.target as HTMLInputElement).value)}
              />
            </Field>

            <Show when={error}>{(message) => <Alert tone="critical">{message}</Alert>}</Show>

            <Button type="submit" disabled={loading}>
              <Show when={loading} fallback="Verify">
                Verifying…
              </Show>
            </Button>
          </form>

          <Button
            variant="ghost"
            size="sm"
            class="self-start"
            onClick={() => {
              useBackup.value = !useBackup.value;
              code.value = "";
              error.value = null;
            }}
          >
            <Show when={useBackup} fallback="Use a backup code instead">
              Use an authenticator code instead
            </Show>
          </Button>
        </Card>
      </PageShell>
    );
  }

  return (
    <PageShell width="narrow">
      <Card class="flex flex-col gap-4">
        <Eyebrow>Welcome back</Eyebrow>
        <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">Sign in</h1>
        <Muted class="text-[13px] m-0">
          Sign in to review held releases and revisit saved reports.
        </Muted>

        <SocialSignIn returnTo={returnTo} onError={(message) => (error.value = message)} />

        <form class="flex flex-col gap-4 mt-2" onSubmit={onSubmit}>
          <Field label="Email" for="login-email">
            <Input
              id="login-email"
              type="email"
              value={email}
              autocomplete="email"
              required
              onInput={(e) => (email.value = (e.target as HTMLInputElement).value)}
            />
          </Field>
          <Field label="Password" for="login-password">
            <Input
              id="login-password"
              type="password"
              value={password}
              autocomplete="current-password"
              required
              onInput={(e) => (password.value = (e.target as HTMLInputElement).value)}
            />
          </Field>

          <Show when={error}>{(message) => <Alert tone="critical">{message}</Alert>}</Show>

          <Button type="submit" disabled={loading}>
            <Show when={loading} fallback="Sign in">
              Signing in…
            </Show>
          </Button>
        </form>

        <p class="text-[13px] text-ink-muted m-0">
          New here? <a href={registerHref}>Create an account</a>
        </p>
      </Card>
    </PageShell>
  );
}
