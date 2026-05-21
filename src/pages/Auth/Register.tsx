import { useEffect } from "preact/hooks";
import { useSignal } from "@preact/signals";
import { useLocation } from "preact-iso";
import { sessionModel } from "../../models/auth";
import { Alert, Button, Card, Eyebrow, Field, Input, PageShell, Muted } from "../../components";

export default function RegisterPage() {
  const location = useLocation();
  const name = useSignal("");
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
    const submittedName = name.value.trim();
    const submittedEmail = email.value.trim();
    const submittedPassword = password.value;
    loading.value = true;
    error.value = null;
    try {
      await sessionModel.signUp(submittedName, submittedEmail, submittedPassword);
      await sessionModel.signIn(submittedEmail, submittedPassword).catch(() => undefined);
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
        <Eyebrow>Get started</Eyebrow>
        <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">Create account</h1>
        <Muted class="text-[13px] m-0">
          Create your review workspace, connect npm, and start checking staged releases.
        </Muted>

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
              minlength={8}
              required
              onInput={(e) => (password.value = (e.target as HTMLInputElement).value)}
            />
          </Field>

          {error.value ? <Alert tone="critical">{error.value}</Alert> : null}

          <Button type="submit" disabled={loading.value}>
            {loading.value ? "Creating…" : "Create account"}
          </Button>
        </form>

        <p class="text-[13px] text-ink-muted m-0">
          Already have an account? <a href="/login">Sign in</a>
        </p>
      </Card>
    </PageShell>
  );
}
