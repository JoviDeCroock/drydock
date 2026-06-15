import { computed, createModel, signal } from "@preact/signals";
import { identifyAnalyticsUser, resetAnalytics, trackProductEvent } from "../lib/analytics";
import { errorMessage } from "./api";

export interface SessionUser {
  id: string;
  name?: string;
  email?: string;
  twoFactorEnabled?: boolean;
}

export interface AuthSession {
  user: SessionUser;
  session?: unknown;
}

// Where the verification link returns the user after they click it. Better Auth
// embeds this as the callbackURL in the emailed link; on success it redirects
// here (signed in), on failure it appends `?error=<code>`.
export const VERIFY_EMAIL_CALLBACK_PATH = "/verify-email";

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
        if (data?.user.id) identifyAnalyticsUser(data.user.id);
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
        trackProductEvent("auth_two_factor_requested", { method: "email_password" });
        return { twoFactorRequired: true };
      }
      await this.load();
      trackProductEvent("auth_sign_in_completed", { method: "email_password" });
      return { twoFactorRequired: false };
    },

    async completeTwoFactorSignIn(code: string, options: { backup?: boolean } = {}): Promise<void> {
      const path = options.backup
        ? "/api/auth/two-factor/verify-backup-code"
        : "/api/auth/two-factor/verify-totp";
      await authPost(path, { code });
      await this.load();
      trackProductEvent("auth_two_factor_completed", {
        method: options.backup ? "backup" : "totp",
      });
    },

    async signUp(name: string, email: string, password: string, returnTo?: string): Promise<void> {
      await authPost("/api/auth/sign-up/email", {
        name,
        email,
        password,
        callbackURL: verificationCallbackPath(returnTo),
      });
      trackProductEvent("auth_sign_up_submitted", { method: "email_password" });
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
      resetAnalytics();
    },

    // Permanently delete the signed-in account. The password is re-verified
    // server-side (reauth) and Better Auth cascades Drydock-owned data; on
    // success the session is gone, so we drop it locally too. Throws AuthError
    // on failure (e.g. wrong password, or still owning a shared organization).
    async deleteAccount(password: string): Promise<void> {
      await authPost("/api/auth/delete-user", { password });
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
