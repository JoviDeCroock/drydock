import { createModel, signal } from "@preact/signals";
import { passwordResetPagePath, RESET_PASSWORD_PATH } from "../lib/auth-return";
import { errorMessage } from "./api";
import { AuthError, authPost, sessionModel } from "./auth";

// Mirrors `emailAndPassword` in server/lib/auth/index.ts, which enforces them.
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

/**
 * The token from an emailed reset link. The server puts it in the fragment
 * (`/reset-password#token=…`) so it never reaches a request log or `Referer`.
 */
export function readResetToken(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const token = params.get("token")?.trim();
  return token || null;
}

/** Why the server would refuse this choice, checked before spending the link. */
export function newPasswordProblem(password: string, confirmation: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  }
  if (password !== confirmation) return "The two passwords don't match.";
  return null;
}

const ERROR_COPY: Record<string, string> = {
  INVALID_TOKEN: "This link is invalid, expired, or already used. Request a new one.",
  PASSWORD_TOO_SHORT: `Use at least ${PASSWORD_MIN_LENGTH} characters.`,
  PASSWORD_TOO_LONG: `Use at most ${PASSWORD_MAX_LENGTH} characters.`,
  RESET_PASSWORD_DISABLED: "Password reset isn't available on this deployment.",
};

function passwordResetErrorMessage(err: unknown): string {
  if (err instanceof AuthError && err.code && ERROR_COPY[err.code]) return ERROR_COPY[err.code]!;
  return errorMessage(err);
}

/**
 * Requesting a link and redeeming one. A request answers the same way whether
 * or not the address has an account, so `sentTo` records what was asked, not
 * that mail went out. Redeeming creates the password when the account had
 * none (a GitHub-only sign-up) and signs out every session the account had.
 */
export const PasswordResetModel = createModel(() => {
  const busy = signal(false);
  const error = signal<string | null>(null);
  const sentTo = signal<string | null>(null);
  const done = signal(false);

  return {
    busy,
    error,
    sentTo,
    done,

    // `returnTo` rides the emailed link back to the reset page, so signing in
    // afterwards still lands where the visitor was headed. The server checks
    // it again before mailing; this only keeps the request well-formed.
    async requestLink(email: string, returnTo?: unknown): Promise<boolean> {
      this.busy.value = true;
      this.error.value = null;
      this.sentTo.value = null;
      const redirectTo = passwordResetPagePath(returnTo);
      try {
        await authPost(
          "/api/auth/request-password-reset",
          redirectTo === RESET_PASSWORD_PATH ? { email } : { email, redirectTo },
        );
        this.sentTo.value = email;
        return true;
      } catch (err) {
        this.error.value = passwordResetErrorMessage(err);
        return false;
      } finally {
        this.busy.value = false;
      }
    },

    async complete(token: string, password: string, confirmation: string): Promise<boolean> {
      const problem = newPasswordProblem(password, confirmation);
      this.error.value = problem;
      if (problem) return false;
      this.busy.value = true;
      try {
        await authPost("/api/auth/reset-password", { token, newPassword: password });
      } catch (err) {
        this.error.value = passwordResetErrorMessage(err);
        this.busy.value = false;
        return false;
      }
      // The server already revoked this browser's session; dropping its
      // cookies too keeps the cached copy from looking signed in for minutes.
      try {
        await sessionModel.signOut();
      } catch {
        sessionModel.session.value = null;
      }
      this.done.value = true;
      this.busy.value = false;
      return true;
    },
  };
});
