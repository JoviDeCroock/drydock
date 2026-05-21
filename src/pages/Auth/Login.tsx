import { useState } from "preact/hooks";
import { useLocation } from "preact-iso";
import { signIn } from "../../models/auth";
import {
  Alert,
  Button,
  Card,
  Eyebrow,
  Field,
  Input,
  PageShell,
  Muted,
} from "../../components";

export default function LoginPage() {
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onSubmit = async (event: Event) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      location.route("/dashboard", true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <PageShell width="narrow">
      <Card class="flex flex-col gap-4">
        <Eyebrow>Welcome back</Eyebrow>
        <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">Sign in</h1>
        <Muted class="text-[13px] m-0">Sign in to review staged releases and revisit saved reports.</Muted>

        <form class="flex flex-col gap-4 mt-2" onSubmit={onSubmit}>
          <Field label="Email" for="login-email">
            <Input
              id="login-email"
              type="email"
              value={email}
              autocomplete="email"
              required
              onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
            />
          </Field>
          <Field label="Password" for="login-password">
            <Input
              id="login-password"
              type="password"
              value={password}
              autocomplete="current-password"
              required
              onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            />
          </Field>

          {error ? <Alert tone="critical">{error}</Alert> : null}

          <Button type="submit" disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </Button>
        </form>

        <p class="text-[13px] text-ink-muted m-0">
          New here? <a href="/register">Create an account</a>
        </p>
      </Card>
    </PageShell>
  );
}
