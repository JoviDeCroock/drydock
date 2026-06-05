import { useModel } from "@preact/signals";
import type { OrganizationRole } from "../../../../server/lib/roles";
import { OrganizationModel } from "../../../models/organization";
import { Alert, Badge, Button, Card, Muted, SectionLabel } from "../../../components";

/**
 * Owner-only control for the org-wide policy that forces a fresh two-factor
 * step-up on every release-gate decision (and blocks members who have not
 * enrolled in 2FA from deciding at all). The route enforces this authoritatively
 * — this section only flips the policy; the gate decision dialog reflects it.
 */
export function ReleaseSecuritySection({
  organizations,
  currentUserRole,
}: {
  organizations: ReturnType<typeof useModel<typeof OrganizationModel.prototype>>;
  currentUserRole: OrganizationRole | null;
}) {
  const active = organizations.active.value;
  const status = organizations.status.value;
  const error = organizations.error.value;
  const saving = status === "updating";
  const isOwner = currentUserRole === "owner";
  const enabled = active?.requireTwoFactorForReleaseDecisions ?? false;

  const toggle = () => {
    if (!active || !isOwner || saving) return;
    void organizations.setReleaseTwoFactor(active.id, !enabled);
  };

  return (
    <Card class="flex flex-col gap-5">
      <div class="flex items-center justify-between gap-2 flex-wrap">
        <SectionLabel>Release security</SectionLabel>
        <Badge tone={enabled ? "ok" : "neutral"}>{enabled ? "required" : "not required"}</Badge>
      </div>

      <Muted class="text-[13px] m-0 max-w-[760px]">
        Require two-factor authentication to approve or block a release gate. Approving a gate
        releases the held GitHub Actions job and publishing proceeds over Trusted Publishing/OIDC,
        which cannot be undone — so when this is on, every member must confirm with a fresh
        authenticator code, and a member who has not enabled 2FA cannot decide a release until they
        do.
      </Muted>

      {active ? (
        isOwner ? (
          <div class="flex flex-col gap-2">
            <Button
              variant={enabled ? "secondary" : "primary"}
              size="sm"
              onClick={toggle}
              disabled={saving}
              class="self-start"
            >
              {saving
                ? "Saving…"
                : enabled
                  ? "Stop requiring two-factor"
                  : "Require two-factor for releases"}
            </Button>
            {active.isPersonal ? (
              <Muted class="text-[12px] m-0">
                This is your personal workspace, so the policy only affects you. It matters most for
                organizations with multiple members.
              </Muted>
            ) : null}
          </div>
        ) : (
          <Muted class="text-[13px] m-0">
            Only the organization owner can change the release two-factor policy.
          </Muted>
        )
      ) : (
        <Muted class="text-[13px] m-0">No organization selected.</Muted>
      )}

      {error ? <Alert tone="critical">{error}</Alert> : null}
    </Card>
  );
}
