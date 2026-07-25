import { useModel, useSignal } from "@preact/signals";
import type { OrganizationRole } from "../../../../server/lib/auth/roles";
import { sessionModel } from "../../../models/auth";
import { OrganizationModel } from "../../../models/organization";
import { Alert } from "../../../components/Alert";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { Muted, SectionLabel } from "../../../components/Typography";

/**
 * Owner-only control for the org-wide policy that forces a fresh two-factor
 * step-up on every release-gate decision (and blocks members who have not
 * enrolled in 2FA from deciding at all). The route enforces this authoritatively
 * — this section flips the policy and mirrors the same 2FA guard the route puts
 * on the change itself: the owner must have enrolled in 2FA before they can
 * require it for everyone, and *relaxing* it asks for a fresh authenticator code
 * (an existing session is not enough) exactly like deciding a gate.
 */
export function ReleaseSecuritySection({
  organizations,
  currentUserRole,
}: {
  organizations: ReturnType<typeof useModel<typeof OrganizationModel.prototype>>;
  currentUserRole: OrganizationRole | null;
}) {
  const codeDraft = useSignal("");
  const active = organizations.active.value;
  const status = organizations.status.value;
  const error = organizations.error.value;
  const saving = status === "updating";
  const isOwner = currentUserRole === "owner";
  const enabled = active?.requireTwoFactorForReleaseDecisions ?? false;
  // Whether *this owner* has 2FA on their own account. The route rejects an
  // unenrolled owner with `two_factor_enrollment_required`, so we gate the action
  // on the same fact instead of letting them submit into a guaranteed error.
  const enrolled = sessionModel.user.value?.twoFactorEnabled === true;
  const code = codeDraft.value.trim();
  // Relaxing the policy needs a fresh code; enabling only hardens, so it doesn't.
  const blockedOnCode = enabled && code.length === 0;

  const enable = () => {
    if (!active || !isOwner || saving || !enrolled) return;
    void organizations.setReleaseTwoFactor(active.id, true);
  };
  const disable = async () => {
    if (!active || !isOwner || saving || !enrolled || blockedOnCode) return;
    const ok = await organizations.setReleaseTwoFactor(active.id, false, code);
    if (ok) codeDraft.value = "";
  };

  return (
    <Card class="flex flex-col gap-5">
      <div class="flex items-center justify-between gap-2 flex-wrap">
        <SectionLabel as="h2">Release security</SectionLabel>
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
          !enrolled ? (
            <Alert tone="warn">
              Turn on two-factor authentication for your own account in{" "}
              <a class="underline text-accent" href="/dashboard/account">
                Account
              </a>{" "}
              before you can require it for releases.
            </Alert>
          ) : enabled ? (
            // Relaxing the policy weakens a security control, so confirm with a
            // fresh authenticator code before submitting — same step-up the gate
            // decision asks for.
            <div class="flex flex-col gap-3">
              <Field label="Authentication code" for="releaseTotp">
                <Input
                  id="releaseTotp"
                  type="text"
                  value={codeDraft.value}
                  placeholder="6-digit code"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  maxLength={8}
                  spellcheck={false}
                  disabled={saving}
                  onInput={(e) => (codeDraft.value = (e.target as HTMLInputElement).value)}
                />
                <Muted class="m-0 mt-1 text-[12px]">
                  Enter the code from your authenticator app to stop requiring two-factor for
                  releases.
                </Muted>
              </Field>
              <Button
                variant="secondary"
                size="sm"
                onClick={disable}
                disabled={saving || blockedOnCode}
                class="self-end"
              >
                {saving ? "Saving…" : "Stop requiring two-factor"}
              </Button>
            </div>
          ) : (
            <div class="flex flex-col gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={enable}
                disabled={saving}
                class="self-end"
              >
                {saving ? "Saving…" : "Require two-factor for releases"}
              </Button>
            </div>
          )
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
