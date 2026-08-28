import { useEffect } from "preact/hooks";
import { useSignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { useLocation } from "preact-iso";
import { sessionModel } from "../../../models/auth";
import { ApiError, apiJson, errorMessage } from "../../../models/api";
import { setActiveOrganizationId } from "../../../models/active-organization";
import { Alert } from "../../../components/Alert";
import { LinkButton } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { LoadingState } from "../../../components/Loading";
import { PageShell } from "../../../components/PageShell";
import { Muted } from "../../../components/Typography";

type InviteState = "checking" | "accepting" | "error";

export default function InvitePage() {
  const location = useLocation();
  const token = typeof location.query.token === "string" ? location.query.token : "";
  const state = useSignal<InviteState>("checking");
  const error = useSignal<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!token) {
        if (cancelled) return;
        error.value = "This invitation link is missing its token.";
        state.value = "error";
        return;
      }
      const session = await sessionModel.load();
      if (cancelled) return;
      if (!session?.user) {
        redirectToLogin(location, token);
        return;
      }
      state.value = "accepting";
      try {
        const data = await apiJson<{ organizationId: string; role: string }>(
          "/api/v1/organizations/invitations/accept",
          { token },
        );
        if (cancelled) return;
        setActiveOrganizationId(data.organizationId);
        location.route("/dashboard", true);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          redirectToLogin(location, token);
          return;
        }
        error.value = errorMessage(err);
        state.value = "error";
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state.value === "error") {
    return (
      <PageShell width="narrow">
        <Card class="flex flex-col gap-4">
          <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">
            We couldn't accept this invite
          </h1>
          <Show when={error}>{(message) => <Alert tone="critical">{message}</Alert>}</Show>
          <Muted class="text-[13px] m-0">
            Ask the person who invited you to send a fresh invitation, then open the new link.
          </Muted>
          <LinkButton href="/dashboard">Go to dashboard</LinkButton>
        </Card>
      </PageShell>
    );
  }

  return (
    <PageShell width="narrow">
      <LoadingState
        title="Joining organization"
        detail={state.value === "accepting" ? "accepting invitation" : "confirming session"}
      />
    </PageShell>
  );
}

function redirectToLogin(location: ReturnType<typeof useLocation>, token: string): void {
  const returnTo = `/dashboard/invite?token=${encodeURIComponent(token)}`;
  location.route(`/login?returnTo=${encodeURIComponent(returnTo)}`, true);
}
