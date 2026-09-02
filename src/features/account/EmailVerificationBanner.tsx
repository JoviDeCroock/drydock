import { useComputed, useSignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { useEffect } from "preact/hooks";
import { authConfigModel, sessionModel } from "../../models/auth";
import { errorMessage } from "../../models/api";
import { Alert } from "../../components/Alert";
import { Button } from "../../components/Button";

/**
 * Pending-verification notice for a signed-in account.
 *
 * Verification is no longer a sign-in gate, so an unverified account can read
 * the dashboard and review published releases. What it cannot do is connect an
 * npm token, record a decision, publish a share link, invite a member, or
 * install the GitHub App — the server refuses those with
 * `email_verification_required`. This says so before the refusal does, and
 * carries the one action that clears it.
 *
 * It renders nothing on deployments that cannot send mail, where no account
 * could ever clear the flag and the notice would be permanent and useless.
 */
export function EmailVerificationBanner() {
  const sending = useSignal(false);
  const sent = useSignal(false);
  const error = useSignal<string | null>(null);

  useEffect(() => {
    void authConfigModel.load();
  }, []);

  const user = sessionModel.user.value;
  const email = user?.email;
  const pending = authConfigModel.emailVerification.value && user?.emailVerified === false;

  const buttonLabel = useComputed(() => (sent.value ? "Sent" : "Resend verification email"));

  if (!pending || !email) return null;

  const resend = async () => {
    if (sending.peek()) return;
    sending.value = true;
    error.value = null;
    try {
      await sessionModel.resendVerification(email);
      sent.value = true;
    } catch (err) {
      error.value = errorMessage(err);
    } finally {
      sending.value = false;
    }
  };

  return (
    <Alert tone="warn">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-col gap-1 min-w-0">
          <strong class="font-medium">Verify {email} to finish setting up</strong>
          <span class="text-ink-muted leading-[1.6]">
            You can review published releases now. Connecting an npm token, recording a decision,
            sharing a report, inviting a member, and installing the GitHub App wait for the link in
            that email.
          </span>
          <Show when={error}>{(message) => <span class="text-danger-text">{message}</span>}</Show>
        </div>
        <Button variant="secondary" size="sm" disabled={sending} onClick={() => void resend()}>
          <Show when={sending} fallback={buttonLabel}>
            Sending…
          </Show>
        </Button>
      </div>
    </Alert>
  );
}
