import { getScan, recordScanEvent, resolveNotificationEmails, type AppDb } from "../db";
import { sendNotificationEmail } from "./email";
import type { RiskLevel } from "./review";
import type { OrganizationRole } from "./roles";

export interface NotifyScanCompletionInput {
  env: Cloudflare.Env;
  db: AppDb;
  scanId: string;
  organizationId: string;
  ownerUserId: string;
  outcome: "complete" | "failed";
  error?: { code: string; message: string };
}

export async function notifyScanCompletion(input: NotifyScanCompletionInput): Promise<void> {
  const { env, db, scanId, organizationId, ownerUserId, outcome, error } = input;
  const [recipients, detail] = await Promise.all([
    resolveNotificationEmails(db, organizationId, ownerUserId),
    getScan(db, scanId, organizationId),
  ]);
  if (recipients.length === 0) {
    await recordScanEvent(db, {
      organizationId,
      actorUserId: ownerUserId,
      scanId,
      type: "scan.notification_failed",
      metadata: { outcome, channel: "email", reason: "no_recipients" },
    });
    return;
  }

  const scan = detail?.scan;
  const packageLabel = formatPackageLabel(scan?.packageName, scan?.stagedVersion);
  const dashboardUrl = scanUrl(env, scanId);
  const subject =
    outcome === "complete"
      ? `Staged release scan complete — ${packageLabel}`
      : `Staged release scan failed — ${packageLabel}`;

  const lines =
    outcome === "complete"
      ? [
          "Hi there,",
          "",
          `We finished scanning the staged release ${packageLabel}.`,
          scan?.risk ? `Overall risk: ${scan.risk}.` : null,
          dashboardUrl ? `Review the report: ${dashboardUrl}` : null,
          "",
          "— Drydock",
        ]
      : [
          "Hi there,",
          "",
          `We could not complete the auto-discovered scan for ${packageLabel}.`,
          error?.message ? `Reason: ${error.message}` : null,
          dashboardUrl ? `Review the scan: ${dashboardUrl}` : null,
          "",
          "— Drydock",
        ];
  const text = lines.filter((line): line is string => line !== null).join("\n");

  await deliverToRecipients(env, db, recipients, { subject, text }, (recipient, result) => ({
    organizationId,
    actorUserId: ownerUserId,
    scanId,
    type: result.ok ? "scan.notification_sent" : "scan.notification_failed",
    metadata: {
      outcome,
      channel: "email",
      recipient,
      ...(result.ok ? {} : { reason: result.reason }),
    },
  }));
}

export interface NotifyWorkflowGateReviewInput {
  env: Cloudflare.Env;
  db: AppDb;
  organizationId: string;
  ownerUserId: string;
  gateId: string;
  repositoryFullName: string;
  environment: string;
  scanId: string;
  packageName: string | null;
  version: string | null;
  releaseRisk: RiskLevel;
}

/**
 * Email the organization's notification recipients that a workflow gate has a
 * completed review parked pending a decision. Drydock never auto-decides a gate,
 * so this is the only proactive signal that a held GitHub deployment is waiting
 * on a human.
 *
 * Recipients resolve via `resolveNotificationEmails`: the org's configured set
 * when present, otherwise the owner's email. Send-once is owned by the caller:
 * `executeWorkflowGateJob` only reaches the review-ready path once per gate (a
 * re-delivered gate with a completed scan short-circuits at its
 * `already_reviewed` guard), so a single review-ready transition produces a
 * single email per recipient. Delivery is best-effort — each send is recorded as
 * a `github_workflow_gate.notification_sent` / `notification_failed` event and
 * never blocks or fails the gate. The body carries only release identity, risk,
 * repo/environment, and a dashboard link; no token, header, or artifact bytes
 * ever reach the email.
 */
export async function notifyWorkflowGateReview(
  input: NotifyWorkflowGateReviewInput,
): Promise<void> {
  const {
    env,
    db,
    organizationId,
    ownerUserId,
    gateId,
    repositoryFullName,
    environment,
    scanId,
    packageName,
    version,
    releaseRisk,
  } = input;

  const recipients = await resolveNotificationEmails(db, organizationId, ownerUserId);
  if (recipients.length === 0) {
    await recordScanEvent(db, {
      organizationId,
      actorUserId: ownerUserId,
      scanId,
      type: "github_workflow_gate.notification_failed",
      metadata: { gateId, channel: "email", reason: "no_recipients" },
    });
    return;
  }

  const packageLabel = formatPackageLabel(packageName, version);
  const dashboardUrl = scanUrl(env, scanId);
  const subject = `Release gate needs your review — ${packageLabel}`;
  const lines = [
    "Hi there,",
    "",
    `A staged release is held in ${repositoryFullName} and is waiting for a decision before it can publish.`,
    "",
    `Package: ${packageLabel}`,
    `Release risk: ${releaseRisk}`,
    `Repository: ${repositoryFullName}`,
    `Environment: ${environment}`,
    "",
    dashboardUrl ? `Approve or block the release: ${dashboardUrl}` : null,
    "",
    "The held GitHub deployment stays blocked until someone approves or rejects it.",
    "",
    "— Drydock",
  ];
  const text = lines.filter((line): line is string => line !== null).join("\n");

  await deliverToRecipients(env, db, recipients, { subject, text }, (recipient, result) => ({
    organizationId,
    actorUserId: ownerUserId,
    scanId,
    type: result.ok
      ? "github_workflow_gate.notification_sent"
      : "github_workflow_gate.notification_failed",
    metadata: {
      gateId,
      channel: "email",
      releaseRisk,
      recipient,
      ...(result.ok ? {} : { reason: result.reason }),
    },
  }));
}

async function deliverToRecipients(
  env: Cloudflare.Env,
  db: AppDb,
  recipients: string[],
  message: { subject: string; text: string },
  event: (
    recipient: string,
    result: { ok: boolean; reason?: string },
  ) => Parameters<typeof recordScanEvent>[1],
): Promise<void> {
  await Promise.all(
    recipients.map(async (recipient) => {
      const result = await sendNotificationEmail(env, {
        to: recipient,
        subject: message.subject,
        text: message.text,
      });
      await recordScanEvent(db, event(recipient, result));
    }),
  );
}

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
}

/**
 * Email an invitee their organization invite link and record the
 * `organization.member_invited` audit event. The link carries the raw bearer
 * token (only its hash is persisted); the body contains no other secrets. The
 * audit event is always recorded — even when email delivery is unavailable — so
 * the pending invite is traceable and the failure reason is captured.
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
          `${input.invitedByName ? input.invitedByName : "An organization owner"} invited you to join ${organizationName} on Drydock as a ${role}.`,
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

function inviteAcceptUrl(env: Cloudflare.Env, token: string): string | null {
  const base = env.BETTER_AUTH_URL;
  if (typeof base !== "string" || !base) return null;
  try {
    const url = new URL("/dashboard/invite", base);
    url.searchParams.set("token", token);
    return url.toString();
  } catch {
    return null;
  }
}

function formatPackageLabel(
  packageName: string | null | undefined,
  version: string | null | undefined,
) {
  if (packageName && version) return `${packageName}@${version}`;
  return packageName ?? "a staged release";
}

function scanUrl(env: Cloudflare.Env, scanId: string): string | null {
  const base = env.BETTER_AUTH_URL;
  if (typeof base !== "string" || !base) return null;
  try {
    const url = new URL(`/dashboard/scans/${encodeURIComponent(scanId)}`, base);
    return url.toString();
  } catch {
    return null;
  }
}
