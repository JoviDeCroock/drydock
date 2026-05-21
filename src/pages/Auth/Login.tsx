import { useState } from "preact/hooks";
import { useLocation } from "preact-iso";
import { signIn } from "../../models/auth";

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
    <main class="page auth-page">
      <section class="auth-card">
        <p class="eyebrow">Welcome back</p>
        <h1>Sign in</h1>
        <p class="muted">All review APIs require a Better Auth session.</p>
        <form class="stack-form" onSubmit={onSubmit}>
          <label>
            Email
            <input type="email" value={email} autocomplete="email" required onInput={(e) => setEmail((e.target as HTMLInputElement).value)} />
          </label>
          <label>
            Password
            <input type="password" value={password} autocomplete="current-password" required onInput={(e) => setPassword((e.target as HTMLInputElement).value)} />
          </label>
          {error ? <div class="banner banner-error">{error}</div> : null}
          <button type="submit" disabled={loading}>{loading ? "Signing in…" : "Sign in"}</button>
        </form>
        <p class="auth-switch">No account yet? <a href="/register">Register</a></p>
      </section>
    </main>
  );
}
