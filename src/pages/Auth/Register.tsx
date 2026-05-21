import { useState } from "preact/hooks";
import { useLocation } from "preact-iso";
import { signIn, signUp } from "../../models/auth";

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
    <main class="page auth-page">
      <section class="auth-card">
        <p class="eyebrow">Get started</p>
        <h1>Create account</h1>
        <p class="muted">Register with Better Auth to run and review staged-publish scans.</p>
        <form class="stack-form" onSubmit={onSubmit}>
          <label>
            Name
            <input type="text" value={name} autocomplete="name" required onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          </label>
          <label>
            Email
            <input type="email" value={email} autocomplete="email" required onInput={(e) => setEmail((e.target as HTMLInputElement).value)} />
          </label>
          <label>
            Password
            <input type="password" value={password} autocomplete="new-password" minlength={8} required onInput={(e) => setPassword((e.target as HTMLInputElement).value)} />
          </label>
          {error ? <div class="banner banner-error">{error}</div> : null}
          <button type="submit" disabled={loading}>{loading ? "Creating…" : "Create account"}</button>
        </form>
        <p class="auth-switch">Already registered? <a href="/login">Sign in</a></p>
      </section>
    </main>
  );
}
