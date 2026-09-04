import { useModel, useSignal } from "@preact/signals";
import type { OrganizationRole } from "../../../../server/lib/auth/roles";
import { OrganizationModel } from "../../../models/organization";
import { sessionModel } from "../../../models/auth";
import { Alert } from "../../../components/Alert";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { Select } from "../../../components/Select";
import { Muted, SectionLabel } from "../../../components/Typography";

// Mirrors MAX_REQUIRED_RELEASE_APPROVALS on the server, which is the value the
// route actually enforces. Kept as a plain number rather than imported so this
// module does not pull server code into the bundle for one integer.
const MAX_REQUIRED_APPROVALS = 10;

/**
 * Owner-only control for how many distinct members must approve a release
 * before it counts as approved.
 *
 * At 1 — the default — the first approval is the decision, which is how every
 * release worked before this existed. Above 1 a release stays undecided (and a
 * gated deployment stays held) until that many different people have approved
 * it, while a single block still stops it outright.
 */
export function ReleaseApprovalsSection({
  organizations,
  currentUserRole,
  memberCount,
}: {
  organizations: ReturnType<typeof useModel<typeof OrganizationModel.prototype>>;
  currentUserRole: OrganizationRole | null;
  /** null while the member list has not loaded; the route caps the bar at this. */
  memberCount: number | null;
}) {
  const active = organizations.active.value;
  const status = organizations.status.value;
  const error = organizations.error.value;
  const saving = status === "updating";
  const isOwner = currentUserRole === "owner";
  const required = active?.requiredReleaseApprovals ?? 1;
  const draft = useSignal<{ organizationId: string; value: string } | null>(null);
  const draftValue = draft.value;
  const activeDraft =
    draftValue && draftValue.organizationId === active?.id ? draftValue.value : null;
  const codeDraft = useSignal("");
  const selected = activeDraft ?? String(required);
  // The server caps the bar at the member count, so offering higher values here
  // would just be a guaranteed error. Until the member list loads we offer the
  // full range and let the route be the authority.
  const ceiling = Math.min(MAX_REQUIRED_APPROVALS, memberCount ?? MAX_REQUIRED_APPROVALS);
  const options = Array.from({ length: Math.max(ceiling, required) }, (_, index) => index + 1);
  const changed = selected !== String(required);
  const lowering = Number(selected) < required;
  const enrolled = sessionModel.user.value?.twoFactorEnabled === true;
  const code = codeDraft.value.trim();
  const blockedOnCode = lowering && code.length === 0;

  const save = async () => {
    if (!active || !isOwner || saving || !changed || (lowering && !enrolled) || blockedOnCode) {
      return;
    }
    const ok = await organizations.setRequiredReleaseApprovals(
      active.id,
      Number(selected),
      lowering ? code : null,
    );
    if (ok) {
      draft.value = null;
      codeDraft.value = "";
    }
  };

  return (
    <Card class="flex flex-col gap-5">
      <div class="flex items-center justify-between gap-2 flex-wrap">
        <SectionLabel as="h2">Release approvals</SectionLabel>
        <Badge tone={required > 1 ? "ok" : "neutral"}>
          {required === 1 ? "one approval" : `${required} approvals`}
        </Badge>
      </div>

      <Muted class="text-[13px] m-0 max-w-[760px]">
        How many different members must approve a release before it counts as approved. With more
        than one, a release stays undecided — and a held GitHub Actions deployment stays held —
        until that many people have signed off, so no single account can ship on its own. Blocking
        never needs a second opinion: one rejection stops the release immediately.
      </Muted>

      {active ? (
        isOwner ? (
          <div class="flex flex-col gap-3">
            {memberCount !== null && memberCount < required ? (
              <Alert tone="warn">
                This organization requires {required} approvals but has {memberCount}{" "}
                {memberCount === 1 ? "member" : "members"}. No release can be approved until you
                invite more members or lower this.
              </Alert>
            ) : null}
            {lowering ? (
              <Alert tone="warn">
                Lowering this bar can immediately approve releases that already have enough votes,
                including held GitHub Actions deployments. Confirm the change with a fresh
                authenticator code.
              </Alert>
            ) : null}
            <Field label="Required approvals" for="requiredApprovals">
              <Select
                id="requiredApprovals"
                value={selected}
                disabled={saving}
                onChange={(value) => {
                  if (active) draft.value = { organizationId: active.id, value };
                }}
              >
                {options.map((option) => (
                  <option key={option} value={String(option)}>
                    {option === 1 ? "1 — the first approval decides" : `${option} approvals`}
                  </option>
                ))}
              </Select>
              {memberCount !== null && ceiling < MAX_REQUIRED_APPROVALS ? (
                <Muted class="m-0 mt-1 text-[12px]">
                  Capped at your {memberCount} {memberCount === 1 ? "member" : "members"} — invite
                  more to require additional approvals.
                </Muted>
              ) : null}
            </Field>
            {lowering ? (
              enrolled ? (
                <Field label="Authentication code" for="releaseApprovalsTotp">
                  <Input
                    id="releaseApprovalsTotp"
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
                    Enter the code from your authenticator app to lower the release approval bar.
                  </Muted>
                </Field>
              ) : (
                <Alert tone="warn">
                  Enable two-factor authentication in{" "}
                  <a class="underline text-accent" href="/dashboard/account">
                    Account
                  </a>{" "}
                  before lowering the release approval bar.
                </Alert>
              )
            ) : null}
            <Button
              variant="primary"
              size="sm"
              onClick={save}
              disabled={saving || !changed || (lowering && !enrolled) || blockedOnCode}
              class="self-end"
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        ) : (
          <Muted class="text-[13px] m-0">
            Only the organization owner can change how many approvals a release needs.
          </Muted>
        )
      ) : (
        <Muted class="text-[13px] m-0">No organization selected.</Muted>
      )}

      {error ? <Alert tone="critical">{error}</Alert> : null}
    </Card>
  );
}
