import { type AppDb } from "../../db/client";
import { getOrganizationName, getOrganizationOwnerUserId } from "../../db/organizations";
import { emitOperationalEvent } from "../platform/observability";
import { deliverOrganizationNotification } from "./deliver";
import { dashboardUrl } from "./links";

export interface NotifyPublicationDiscrepancyInput {
  env: Cloudflare.Env;
  db: AppDb;
  organizationId: string;
  packageName: string;
  version: string;
  status: "published_without_approval" | "published_despite_rejection" | "artifact_mismatch";
}

const DESCRIPTIONS = {
  published_without_approval: {
    title: "Published without prior approval",
    detail: "No approval in this organization predates the publication of this release.",
  },
  published_despite_rejection: {
    title: "Published despite rejection",
    detail: "This release was published after it was rejected in this organization.",
  },
  artifact_mismatch: {
    title: "Published artifact differs from approval",
    detail:
      "The published package bytes do not match the artifact approved in this organization before publication.",
  },
} as const;

/**
 * Tell the organization about a release the publication monitor flagged. The
 * monitor claims each alert before delivery; the message describes the recorded
 * evidence without inferring credential compromise or registry bypass.
 *
 * Returns whether the organization was actually reached. An organization with
 * no owner row has nobody to tell, and the caller keeps the alert pending
 * rather than recording a delivery that never happened.
 */
export async function notifyPublicationDiscrepancy(
  input: NotifyPublicationDiscrepancyInput,
): Promise<boolean> {
  const { env, db, organizationId, packageName, version, status } = input;
  const ownerUserId = await getOrganizationOwnerUserId(db, organizationId);
  if (!ownerUserId) {
    emitOperationalEvent("warn", "publication_alert.no_owner", { organizationId, packageName });
    return false;
  }
  const organizationName = await getOrganizationName(db, organizationId);
  const { title, detail } = DESCRIPTIONS[status];
  const release = `${packageName}@${version}`;
  const link = dashboardUrl(env, organizationId);
  await deliverOrganizationNotification(env, db, {
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
        "Review the publication evidence and acknowledge the alert on your dashboard.",
        "If the release was unexpected, investigate who published it and review publishing access.",
        link ? `Dashboard: ${link}` : null,
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
  return true;
}
