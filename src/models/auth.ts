import { computed, createModel, signal } from "@preact/signals";

export interface SessionUser {
  id: string;
  name?: string;
  email?: string;
}

export interface AuthSession {
  user: SessionUser;
  session?: unknown;
}

export const SessionModel = createModel(() => {
  const session = signal<AuthSession | null>(null);
  const loaded = signal(false);
  const error = signal<string | null>(null);
  const user = computed(() => session.value?.user ?? null);
  const authenticated = computed(() => session.value !== null);

  return {
    session,
    loaded,
    error,
    user,
    authenticated,

    async load(): Promise<AuthSession | null> {
      try {
        const data = await fetchSession();
        this.session.value = data;
        this.error.value = null;
        return data;
      } catch (err) {
        this.error.value = err instanceof Error ? err.message : String(err);
        this.session.value = null;
        return null;
      } finally {
        this.loaded.value = true;
      }
    },

    async signIn(email: string, password: string): Promise<void> {
      await authPost("/api/auth/sign-in/email", { email, password, rememberMe: true });
      await this.load();
    },

    async signUp(name: string, email: string, password: string): Promise<void> {
      await authPost("/api/auth/sign-up/email", { name, email, password });
    },

    async signOut(): Promise<void> {
      await authPost("/api/auth/sign-out", {});
      this.session.value = null;
    },
  };
});

export const sessionModel = new SessionModel();

async function fetchSession(): Promise<AuthSession | null> {
  const res = await fetch("/api/auth/get-session", {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!res.ok) return null;
  return (await res.json()) as AuthSession | null;
}

async function authPost(path: string, body: unknown) {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
  if (!res.ok) {
    throw new Error(data?.message || data?.error || "authentication failed");
  }
}
