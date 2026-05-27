import { getScan, getUserContact, recordScanEvent, type AppDb } from "../db";
import { sendNotificationEmail } from "./email";

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
