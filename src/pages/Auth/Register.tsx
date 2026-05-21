import { useState } from "preact/hooks";
import { useLocation } from "preact-iso";
import { signIn, signUp } from "../../models/auth";
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

export default function RegisterPage() {
  const location = useLocation();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onSubmit = async (event: Event) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await signUp(name.trim(), email.trim(), password);
      await signIn(email.trim(), password).catch(() => undefined);
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
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
            />
          </Field>
          <Field label="Email" for="register-email">
            <Input
              id="register-email"
              type="email"
              value={email}
              autocomplete="email"
              required
              onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
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
              onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            />
          </Field>

          {error ? <Alert tone="critical">{error}</Alert> : null}

          <Button type="submit" disabled={loading}>
            {loading ? "Creating…" : "Create account"}
          </Button>
        </form>

        <p class="text-[13px] text-ink-muted m-0">
          Already have an account? <a href="/login">Sign in</a>
        </p>
      </Card>
    </PageShell>
  );
}
