import { useEffect } from "preact/hooks";
import { useSignal } from "@preact/signals";
import { useLocation } from "preact-iso";
import { normalizeAuthReturnTo } from "../../lib/auth-return";
import { sessionModel } from "../../models/auth";
import { errorMessage } from "../../models/api";
import {
  Alert,
  Button,
  Card,
  Eyebrow,
  Field,
  Input,
  LoadingState,
  Muted,
  PageShell,
} from "../../components";

type VerifyState = "verifying" | "verified" | "error";

const ERROR_COPY: Record<string, string> = {
  TOKEN_EXPIRED: "This verification link has expired.",
  INVALID_TOKEN: "This verification link is invalid.",
  USER_NOT_FOUND: "We couldn't find an account for this link.",
};

export default function VerifyEmailPage() {
  const location = useLocation();
  const errorCode = typeof location.query.error === "string" ? location.query.error : "";
  const returnTo = normalizeAuthReturnTo(location.query.returnTo);
  const state = useSignal<VerifyState>(errorCode ? "error" : "verifying");
  const email = useSignal("");
  const error = useSignal<string | null>(null);
  const resending = useSignal(false);
  const resent = useSignal(false);

  useEffect(() => {
    if (errorCode) return;
    let cancelled = false;
    void sessionModel.load().then((session) => {
      if (cancelled) return;
      // Verification auto-signs the user in, so a live session means success.
      if (session?.user) {
        location.route(returnTo, true);
        return;
      }
      state.value = "verified";
    });
    return () => {
      cancelled = true;
    };
  }, [errorCode, returnTo]);

  const onResend = async (event: Event) => {
    event.preventDefault();
    const target = email.value.trim();
    if (!target) return;
    resending.value = true;
    resent.value = false;
    error.value = null;
    try {
      await sessionModel.resendVerification(target, returnTo);
      resent.value = true;
    } catch (err) {
      error.value = errorMessage(err);
    } finally {
      resending.value = false;
    }
  };

  if (state.value === "verifying") {
    return (
      <PageShell width="narrow">
        <LoadingState title="Verifying your email" detail="confirming link" />
      </PageShell>
    );
  }

  if (state.value === "verified") {
    return (
      <PageShell width="narrow">
        <Card class="flex flex-col gap-4">
          <Eyebrow>Email verified</Eyebrow>
          <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">You're all set</h1>
          <Alert tone="ok">Your email is verified — you can sign in now.</Alert>
          <Button onClick={() => location.route("/login", true)}>Go to sign in</Button>
        </Card>
      </PageShell>
    );
  }

  return (
    <PageShell width="narrow">
      <Card class="flex flex-col gap-4">
        <Eyebrow>Verify your email</Eyebrow>
        <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">Link didn't work</h1>
        <Alert tone="critical">{ERROR_COPY[errorCode] ?? "We couldn't verify your email."}</Alert>
        <Muted class="text-[13px] m-0">
          Enter your email and we'll send a fresh verification link.
        </Muted>

        <form class="flex flex-col gap-4 mt-2" onSubmit={onResend}>
          <Field label="Email" for="verify-email">
            <Input
              id="verify-email"
              type="email"
              value={email}
              autocomplete="email"
              required
              onInput={(e) => (email.value = (e.target as HTMLInputElement).value)}
            />
          </Field>

          {error.value ? <Alert tone="critical">{error.value}</Alert> : null}
          {resent.value ? (
            <Alert tone="ok">If that account needs verifying, a new link is on its way.</Alert>
          ) : null}

          <Button type="submit" disabled={resending.value}>
            {resending.value ? "Sending…" : "Send new link"}
          </Button>
        </form>

        <p class="text-[13px] text-ink-muted m-0">
          <a href="/login">Back to sign in</a>
        </p>
      </Card>
    </PageShell>
  );
}
