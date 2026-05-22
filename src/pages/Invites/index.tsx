import { useEffect } from "preact/hooks";
import { useModel, useSignal } from "@preact/signals";
import { useLocation, useRoute } from "preact-iso";
import { sessionModel } from "../../models/auth";
import { setActiveOrganizationId } from "../../models/active-organization";
import { InviteAcceptModel } from "../../models/invites";
import {
  Alert,
  Badge,
  Button,
  Card,
  Eyebrow,
  LoadingState,
  Muted,
  PageShell,
} from "../../components";

export default function InvitePage() {
  const route = useRoute();
  const location = useLocation();
  const invite = useModel(InviteAcceptModel);
  const sessionChecked = useSignal(false);

  const token = route.params.token || "";

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const data = await sessionModel.load();
      if (cancelled) return;
      if (!data) {
        const next = `/invites/${encodeURIComponent(token)}`;
        location.route(`/login?next=${encodeURIComponent(next)}`, true);
        return;
      }
      sessionChecked.value = true;
      if (token) await invite.load(token);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onAccept = async () => {
    const result = await invite.accept();
    if (!result) return;
    setActiveOrganizationId(result.organization.id);
    location.route("/dashboard", true);
  };

  const onDecline = () => {
    location.route("/dashboard", true);
  };

  if (!sessionChecked.value || !invite.loaded.value) {
    return (
      <PageShell width="narrow">
        <LoadingState title="Loading invite" detail="confirming session" />
      </PageShell>
    );
  }

  if (invite.error.value && !invite.preview.value) {
    return (
      <PageShell width="narrow">
        <Card class="flex flex-col gap-4">
          <Eyebrow>Invite</Eyebrow>
          <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">Invite unavailable</h1>
          <Alert tone="critical">{invite.error.value}</Alert>
          <Muted class="text-[13px] m-0">
            <a href="/dashboard">Go to dashboard</a>
          </Muted>
        </Card>
      </PageShell>
    );
  }

  const preview = invite.preview.value;
  if (!preview) {
    return (
      <PageShell width="narrow">
        <Card class="flex flex-col gap-4">
          <Eyebrow>Invite</Eyebrow>
          <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">Invite not found</h1>
          <Muted class="text-[13px] m-0">
            <a href="/dashboard">Go to dashboard</a>
          </Muted>
        </Card>
      </PageShell>
    );
  }

  const status = preview.status;
  const pending = status === "pending";
  const alreadyMember = invite.alreadyMember.value;

  return (
    <PageShell width="narrow">
      <Card class="flex flex-col gap-4">
        <Eyebrow>You've been invited</Eyebrow>
        <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">{preview.organizationName}</h1>
        <div class="flex flex-wrap items-center gap-2 text-[13px] text-ink-muted">
          <span>Role</span>
          <Badge tone="info">{preview.role}</Badge>
          <span>•</span>
          <span>Status</span>
          <Badge tone={status === "accepted" ? "ok" : status === "pending" ? "info" : "critical"}>
            {status}
          </Badge>
        </div>
        <Muted class="text-[13px] m-0">
          {pending
            ? `Accepting this invite adds you to ${preview.organizationName} as a ${preview.role}. The invite expires ${formatDate(preview.expiresAt)}.`
            : status === "expired"
              ? "This invite has expired. Ask the organization owner to send a new link."
              : status === "revoked"
                ? "This invite was revoked by an owner."
                : "This invite has already been accepted."}
        </Muted>

        {alreadyMember ? (
          <Alert tone="info">You are already a member of this organization.</Alert>
        ) : null}

        {invite.error.value ? <Alert tone="critical">{invite.error.value}</Alert> : null}

        <div class="flex flex-wrap items-center gap-2 mt-2">
          <Button
            onClick={() => void onAccept()}
            disabled={!pending || alreadyMember || invite.busy.value}
          >
            {invite.busy.value ? "Accepting…" : "Accept invite"}
          </Button>
          <Button variant="secondary" onClick={onDecline} disabled={invite.busy.value}>
            {pending ? "Decline" : "Back to dashboard"}
          </Button>
        </div>
      </Card>
    </PageShell>
  );
}

function formatDate(value: string | number | Date) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "soon" : date.toLocaleString();
}
