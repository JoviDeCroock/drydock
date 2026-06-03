import { useEffect } from "preact/hooks";
import { useSignal } from "@preact/signals";
import { useLocation } from "preact-iso";
import { normalizeAuthReturnTo } from "../../lib/auth-return";
import { AuthError, sessionModel } from "../../models/auth";
import { errorMessage } from "../../models/api";
import { Alert, Button, Card, Eyebrow, Field, Input, PageShell, Muted } from "../../components";

export default function LoginPage() {
  const location = useLocation();
  const email = useSignal("");
  const password = useSignal("");
  const error = useSignal<string | null>(null);
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
      await sessionModel.signIn(submittedEmail, submittedPassword);
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
      await sessionModel.resendVerification(target);
      resent.value = true;
    } catch (err) {
      error.value = errorMessage(err);
    } finally {
      resending.value = false;
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

          {error.value ? <Alert tone="critical">{error.value}</Alert> : null}
          {resent.value ? <Alert tone="ok">We sent another verification link.</Alert> : null}

          <Button variant="secondary" disabled={resending.value} onClick={onResend}>
            {resending.value ? "Resending…" : "Resend verification email"}
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

  return (
    <PageShell width="narrow">
      <Card class="flex flex-col gap-4">
        <Eyebrow>Welcome back</Eyebrow>
        <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">Sign in</h1>
        <Muted class="text-[13px] m-0">
          Sign in to review staged releases and revisit saved reports.
        </Muted>

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

          {error.value ? <Alert tone="critical">{error.value}</Alert> : null}

          <Button type="submit" disabled={loading.value}>
            {loading.value ? "Signing in…" : "Sign in"}
          </Button>
        </form>

        <p class="text-[13px] text-ink-muted m-0">
          New here? <a href={registerHref}>Create an account</a>
        </p>
      </Card>
    </PageShell>
  );
}
