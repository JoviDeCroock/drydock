import { type AppDb } from "../../db/client";
import { recordScanEvent } from "../../db/events";
import type { OrganizationRole } from "../auth/roles";
import { normalizeUserName } from "../auth/user-name";
import { toSingleLineText } from "../platform/single-line-text";
import { sendNotificationEmail } from "./email";
import { inviteAcceptUrl } from "./links";

export interface NotifyOrganizationInviteInput {
  env: Cloudflare.Env;
  db: AppDb;
  organizationId: string;
  organizationName: string;
  email: string;
  role: OrganizationRole;
  token: string;
  invitedByUserId: string;
  invitedByName?: string | null;
  invitedByEmail?: string | null;
}

/**
 * Who sent the invite, as one factual line. The inviter's address leads: it is
 * verified (creating an invite requires it), while the name is their own free
 * text, so it is flattened again here (rows written before names were
 * normalized are still read) and quoted, never presented as the sender.
 */
function describeInviter(name?: string | null, email?: string | null): string {
  const displayName = name ? normalizeUserName(name) : "";
  const address = email ? toSingleLineText(email, 254) : "";
  const quoted = displayName ? `"${displayName}"` : "";
  if (address && quoted) return `${address} (${quoted})`;
  return address || quoted || "An organization owner";
}

/**
 * Email an invitee their organization invite link and record the
 * `organization.member_invited` audit event. The link carries the raw bearer
 * token (only its hash is persisted); the body contains no other secrets. The
 * audit event is always recorded — even when email delivery is unavailable — so
 * the pending invite is traceable and the failure reason is captured.
 *
 * This is not an organization notification: it goes to one address the caller
 * chose, and the actor is the inviter, so it does not use
 * `deliverOrganizationNotification`.
 */
export async function notifyOrganizationInvite(
  input: NotifyOrganizationInviteInput,
): Promise<void> {
  const { env, db, organizationId, organizationName, email, role, token, invitedByUserId } = input;
  const inviteUrl = inviteAcceptUrl(env, token);

  const result = inviteUrl
    ? await sendNotificationEmail(env, {
        to: email,
        subject: `You're invited to ${organizationName} on Drydock`,
        text: [
          "Hi there,",
          "",
          `${describeInviter(input.invitedByName, input.invitedByEmail)} invited you to join ${organizationName} on Drydock as a ${role}.`,
          "",
          `Accept the invitation: ${inviteUrl}`,
          "",
          "If you don't have a Drydock account yet, create one with this email address and the link will add you to the organization.",
          "",
          "This invitation expires in 7 days.",
          "",
          "— Drydock",
        ].join("\n"),
      })
    : { ok: false, reason: "BETTER_AUTH_URL is not configured" };

  await recordScanEvent(db, {
    organizationId,
    actorUserId: invitedByUserId,
    type: result.ok ? "organization.member_invited" : "organization.member_invite_failed",
    metadata: {
      email,
      role,
      channel: "email",
      ...(result.ok ? {} : { reason: result.reason }),
    },
  });
}
