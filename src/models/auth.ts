export interface SessionUser {
  id: string;
  name?: string;
  email?: string;
}

export interface AuthSession {
  user: SessionUser;
  session?: unknown;
}

export async function getSession(): Promise<AuthSession | null> {
  const res = await fetch("/api/auth/get-session", {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!res.ok) return null;
  return (await res.json()) as AuthSession | null;
}

export async function signIn(email: string, password: string): Promise<void> {
  await authPost("/api/auth/sign-in/email", { email, password, rememberMe: true });
}

export async function signUp(name: string, email: string, password: string): Promise<void> {
  await authPost("/api/auth/sign-up/email", { name, email, password });
}

export async function signOut(): Promise<void> {
  await authPost("/api/auth/sign-out", {});
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
