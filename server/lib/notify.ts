import { getScan, getUserContact, recordScanEvent, type AppDb } from "../db";
import { sendNotificationEmail } from "./email";
import type { RiskLevel } from "./review";

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
  const [contact, detail] = await Promise.all([
    getUserContact(db, ownerUserId),
    getScan(db, scanId, organizationId),
  ]);
  if (!contact?.email) {
    console.warn("scan notification skipped: no email on record", { scanId, ownerUserId });
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
          `Hi ${contact.name ?? "there"},`,
          "",
          `We finished scanning the staged release ${packageLabel}.`,
          scan?.risk ? `Overall risk: ${scan.risk}.` : null,
          dashboardUrl ? `Review the report: ${dashboardUrl}` : null,
          "",
          "— Drydock",
        ]
      : [
          `Hi ${contact.name ?? "there"},`,
          "",
          `We could not complete the auto-discovered scan for ${packageLabel}.`,
          error?.message ? `Reason: ${error.message}` : null,
          dashboardUrl ? `Review the scan: ${dashboardUrl}` : null,
          "",
          "— Drydock",
        ];
  const text = lines.filter((line): line is string => line !== null).join("\n");

  const result = await sendNotificationEmail(env, {
    to: contact.email,
    subject,
    text,
  });

  await recordScanEvent(db, {
    organizationId,
    actorUserId: ownerUserId,
    scanId,
    type: result.ok ? "scan.notification_sent" : "scan.notification_failed",
    metadata: {
      outcome,
      channel: "email",
      ...(result.ok ? {} : { reason: result.reason }),
    },
  });
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
 * Email the maintainer that a workflow gate has a completed review parked
 * pending their decision. Drydock never auto-decides a gate, so this is the only
 * proactive signal that a held GitHub deployment is waiting on a human.
 *
 * Send-once is owned by the caller: `executeWorkflowGateJob` only reaches the
 * review-ready path once per gate (a re-delivered gate with a completed scan
 * short-circuits at its `already_reviewed` guard), so a single review-ready
 * transition produces a single email. Delivery is best-effort — the outcome is
 * recorded as a `github_workflow_gate.notification_sent` /
 * `notification_failed` event and never blocks or fails the gate. The body
 * carries only release identity, risk, repo/environment, and a dashboard link;
 * no token, header, or artifact bytes ever reach the email.
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

  const contact = await getUserContact(db, ownerUserId);
  if (!contact?.email) {
    await recordScanEvent(db, {
      organizationId,
      actorUserId: ownerUserId,
      scanId,
      type: "github_workflow_gate.notification_failed",
      metadata: { gateId, channel: "email", reason: "no_contact_email" },
    });
    return;
  }

  const packageLabel = formatPackageLabel(packageName, version);
  const dashboardUrl = scanUrl(env, scanId);
  const subject = `Release gate needs your review — ${packageLabel}`;
  const lines = [
    `Hi ${contact.name ?? "there"},`,
    "",
    `A staged release is held in ${repositoryFullName} and is waiting for your decision before it can publish.`,
    "",
    `Package: ${packageLabel}`,
    `Release risk: ${releaseRisk}`,
    `Repository: ${repositoryFullName}`,
    `Environment: ${environment}`,
    "",
    dashboardUrl ? `Approve or block the release: ${dashboardUrl}` : null,
    "",
    "The held GitHub deployment stays blocked until you approve or reject it.",
    "",
    "— Drydock",
  ];
  const text = lines.filter((line): line is string => line !== null).join("\n");

  const result = await sendNotificationEmail(env, {
    to: contact.email,
    subject,
    text,
  });

  await recordScanEvent(db, {
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
      ...(result.ok ? {} : { reason: result.reason }),
    },
  });
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
