import { computed, createModel, signal } from "@preact/signals";
import { errorMessage } from "./api";

interface SessionUser {
  id: string;
  name?: string;
  email?: string;
  twoFactorEnabled?: boolean;
}

interface AuthSession {
  user: SessionUser;
  session?: unknown;
}

// Where the verification link returns the user after they click it. Better Auth
// embeds this as the callbackURL in the emailed link; on success it redirects
// here (signed in), on failure it appends `?error=<code>`.
const VERIFY_EMAIL_CALLBACK_PATH = "/verify-email";

export function verificationCallbackPath(returnTo?: string): string {
  if (!returnTo || returnTo === "/dashboard") return VERIFY_EMAIL_CALLBACK_PATH;
  return `${VERIFY_EMAIL_CALLBACK_PATH}?returnTo=${encodeURIComponent(returnTo)}`;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

const SessionModel = createModel(() => {
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
        this.error.value = errorMessage(err);
        this.session.value = null;
        return null;
      } finally {
        this.loaded.value = true;
      }
    },

    async signIn(
      email: string,
      password: string,
      returnTo?: string,
    ): Promise<{ twoFactorRequired: boolean }> {
      const data = await authPost("/api/auth/sign-in/email", {
        email,
        password,
        rememberMe: true,
        callbackURL: verificationCallbackPath(returnTo),
      });
      if (
        data &&
        typeof data === "object" &&
        (data as { twoFactorRedirect?: unknown }).twoFactorRedirect
      ) {
        return { twoFactorRequired: true };
      }
      await this.load();
      return { twoFactorRequired: false };
    },

    async completeTwoFactorSignIn(code: string, options: { backup?: boolean } = {}): Promise<void> {
      const path = options.backup
        ? "/api/auth/two-factor/verify-backup-code"
        : "/api/auth/two-factor/verify-totp";
      await authPost(path, { code });
      await this.load();
    },

    // Starts the GitHub OAuth redirect. Better Auth returns the provider's
    // authorize URL; the browser navigates there and comes back through
    // /api/auth/callback/github, which redirects to callbackURL signed in. On
    // failure it lands on errorPath (the page that started the flow) with
    // ?error=…, keeping returnTo so a retry still ends up in the right place.
    async signInWithGitHub(
      returnTo?: string,
      errorPath: "/login" | "/register" = "/login",
    ): Promise<void> {
      const destination = returnTo ?? "/dashboard";
      const errorCallbackURL =
        destination === "/dashboard"
          ? `${errorPath}?error=github`
          : `${errorPath}?error=github&returnTo=${encodeURIComponent(destination)}`;
      const data = await authPost("/api/auth/sign-in/social", {
        provider: "github",
        callbackURL: destination,
        errorCallbackURL,
      });
      const url = data && typeof data === "object" ? (data as { url?: unknown }).url : null;
      if (typeof url !== "string" || !url) {
        throw new AuthError("GitHub sign-in could not start");
      }
      window.location.assign(url);
    },

    async signUp(name: string, email: string, password: string, returnTo?: string): Promise<void> {
      await authPost("/api/auth/sign-up/email", {
        name,
        email,
        password,
        callbackURL: verificationCallbackPath(returnTo),
      });
    },

    async resendVerification(email: string, returnTo?: string): Promise<void> {
      await authPost("/api/auth/send-verification-email", {
        email,
        callbackURL: verificationCallbackPath(returnTo),
      });
    },

    async signOut(): Promise<void> {
      await authPost("/api/auth/sign-out", {});
      this.session.value = null;
    },

    // Permanently delete the signed-in account. Password accounts reauthenticate
    // with their credential; social-only accounts omit it and Better Auth
    // requires the OAuth-created session to still be fresh. On success the
    // session is gone, so we drop it locally too.
    async deleteAccount(password?: string): Promise<void> {
      await authPost("/api/auth/delete-user", password ? { password } : {});
      this.session.value = null;
    },
  };
});

export const sessionModel = new SessionModel();

// Which optional sign-in methods the deployment offers (GET /api/auth/config,
// anonymous). Defaults stay false on any failure so the password form — which
// needs no configuration — is never blocked on this lookup.
const AuthConfigModel = createModel(() => {
  const githubSignIn = signal(false);
  const loaded = signal(false);

  return {
    githubSignIn,
    loaded,

    async load(): Promise<void> {
      if (this.loaded.peek()) return;
      try {
        const res = await fetch("/api/auth/config", {
          credentials: "same-origin",
          headers: { accept: "application/json" },
        });
        if (!res.ok) return;
        const data = (await res.json()) as { githubSignIn?: boolean } | null;
        this.githubSignIn.value = Boolean(data?.githubSignIn);
        this.loaded.value = true;
      } catch {
        // Offline or misconfigured — leave every optional method hidden and
        // retry when the auth surface mounts again.
      }
    },
  };
});

export const authConfigModel = new AuthConfigModel();

// How *this* user's account can authenticate (GET /api/auth/list-accounts).
// Better Auth files a password under the `credential` provider, and an account
// created by GitHub sign-in has no such row — which matters because every
// two-factor endpoint reauthenticates with a password, so a GitHub-only
// account cannot enrol. The result is keyed by user id so client-side sign-out
// followed by a different sign-in cannot reuse the previous account's methods.
// `hasPassword` starts true and stays true on any failure: the password dialog
// is the long-standing path, so a failed lookup must never take it away from an
// account that does have one.
const SignInMethodsModel = createModel(() => {
  const hasPassword = signal(true);
  const loaded = signal(false);
  const loadedForUserId = signal<string | null>(null);
  let loadGeneration = 0;

  return {
    hasPassword,
    loaded,

    async load(userId: string): Promise<void> {
      const generation = ++loadGeneration;
      if (loadedForUserId.peek() === userId) return;
      loadedForUserId.value = null;
      this.hasPassword.value = true;
      this.loaded.value = false;
      try {
        const res = await fetch("/api/auth/list-accounts", {
          credentials: "same-origin",
          headers: { accept: "application/json" },
        });
        if (res.ok) {
          const accounts = (await res.json()) as { providerId?: string }[] | null;
          if (generation === loadGeneration && Array.isArray(accounts)) {
            this.hasPassword.value = accounts.some((a) => a?.providerId === "credential");
            loadedForUserId.value = userId;
          }
        }
      } catch {
        // Offline or unauthenticated — leave the password path offered.
      } finally {
        if (generation === loadGeneration) this.loaded.value = true;
      }
    },
  };
});

export const signInMethodsModel = new SignInMethodsModel();

async function fetchSession(): Promise<AuthSession | null> {
  const res = await fetch("/api/auth/get-session", {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!res.ok) return null;
  return (await res.json()) as AuthSession | null;
}

export async function authPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as {
    error?: string;
    message?: string;
    code?: string;
  } | null;
  if (!res.ok) {
    throw new AuthError(
      data?.message || data?.error || "authentication failed",
      data?.code,
      res.status,
    );
  }
  return data;
}
