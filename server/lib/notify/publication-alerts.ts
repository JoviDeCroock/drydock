import { type AppDb } from "../../db/client";
import { getOrganizationName, getOrganizationOwnerUserId } from "../../db/organizations";
import { emitOperationalEvent } from "../platform/observability";
import { deliverOrganizationNotification, type NotificationDeliveryOutcome } from "./deliver";
import { packageUrl } from "./links";

export interface NotifyPublicationDiscrepancyInput {
  env: Cloudflare.Env;
  db: AppDb;
  organizationId: string;
  packageName: string;
  version: string;
  status: "published_without_approval" | "published_despite_rejection" | "artifact_mismatch";
}

// Every claim is about the alerting organization's own records. Another
// organization may have reviewed or approved the same release; Drydock never
// says so here (that would disclose one organization's activity to another),
// so the copy must not read as "nobody reviewed this" or accuse a publisher.
function describe(status: NotifyPublicationDiscrepancyInput["status"], organization: string) {
  switch (status) {
    case "published_without_approval":
      return {
        title: `Published with no approval in ${organization}`,
        detail: `No approval in ${organization} predates the publication of this release.`,
      };
    case "published_despite_rejection":
      return {
        title: `Published despite a rejection in ${organization}`,
        detail: `This release was published after it was rejected in ${organization}.`,
      };
    case "artifact_mismatch":
      return {
        title: `Published bytes differ from what ${organization} reviewed`,
        detail: `The published package bytes match no artifact reviewed in ${organization} for this version.`,
      };
  }
}

/**
 * Tell the organization about a release the publication monitor flagged. The
 * monitor claims each alert before delivery; the message describes the recorded
 * evidence without inferring credential compromise or registry bypass.
 *
 * Returns the delivery outcome so the caller records a notification only once
 * someone was reached, or once there is nobody to reach. An organization with
 * no owner row is an anomaly rather than a settled lack of recipients, so it
 * reports `failed` and the caller keeps the alert pending.
 */
export async function notifyPublicationDiscrepancy(
  input: NotifyPublicationDiscrepancyInput,
): Promise<NotificationDeliveryOutcome> {
  const { env, db, organizationId, packageName, version, status } = input;
  const ownerUserId = await getOrganizationOwnerUserId(db, organizationId);
  if (!ownerUserId) {
    emitOperationalEvent("warn", "publication_alert.no_owner", { organizationId, packageName });
    return "failed";
  }
  const organizationName = await getOrganizationName(db, organizationId);
  const { title, detail } = describe(status, organizationName ?? "your organization");
  const release = `${packageName}@${version}`;
  const link = packageUrl(env, packageName, organizationId);
  return deliverOrganizationNotification(env, db, {
    organizationId,
    ownerUserId,
    eventPrefix: "scan",
    eventMetadata: { trigger: "publication_discrepancy", packageName, version, status },
    email: {
      subject: `${title} — ${release}`,
      lines: [
        "Hi there,",
        "",
        `${release}: ${detail}`,
        organizationName ? `Organization: ${organizationName}` : null,
        "",
        "Drydock compares each release only with this organization's own reviews and decisions.",
        "Review the publication evidence and acknowledge the alert on the package's page.",
        link ? `Package: ${link}` : null,
        "",
        "— Drydock",
      ],
    },
    slack: {
      title,
      packageLabel: release,
      source: "publication monitor",
      statusLine: detail,
      dashboardUrl: link,
    },
  });
}
