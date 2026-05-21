import { useEffect } from "preact/hooks";
import { useSignal } from "@preact/signals";
import { useLocation } from "preact-iso";
import { sessionModel } from "../../models/auth";
import { Alert, Button, Card, Eyebrow, Field, Input, PageShell, Muted } from "../../components";

export default function LoginPage() {
  const location = useLocation();
  const email = useSignal("");
  const password = useSignal("");
  const error = useSignal<string | null>(null);
  const loading = useSignal(false);

  useEffect(() => {
    let cancelled = false;
    void sessionModel.load().then((session) => {
      if (cancelled) return;
      if (session?.user) location.route("/dashboard", true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSubmit = async (event: Event) => {
    event.preventDefault();
    const submittedEmail = email.value.trim();
    const submittedPassword = password.value;
    loading.value = true;
    error.value = null;
    try {
      await sessionModel.signIn(submittedEmail, submittedPassword);
      location.route("/dashboard", true);
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  };

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
          New here? <a href="/register">Create an account</a>
        </p>
      </Card>
    </PageShell>
  );
}
