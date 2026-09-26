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
  /** The observation's recorded reason, which refines the wording. */
  reason?: string | null;
}

const UNDECIDED_REVIEW_REASONS = new Set([
  "review_pending",
  "review_failed",
  "reviewed_without_decision",
]);

// Every claim is about the alerting organization's own records. Another
// organization may have reviewed or approved the same release; Drydock never
// says so here (that would disclose one organization's activity to another),
// so the copy must not read as "nobody reviewed this" or accuse a publisher.
// An undecided review of the published bytes is most often the owner's own
// release promoted before anyone decided, so it asks for the decision first.
function describe(
  status: NotifyPublicationDiscrepancyInput["status"],
  reason: string | null | undefined,
  organization: string,
) {
  const newestOnly =
    reason === "review_history_limit"
      ? " Only the latest 100 Drydock records of this version were compared."
      : "";
  switch (status) {
    case "published_without_approval":
      return {
        title: `Published with no approval in ${organization}`,
        detail: UNDECIDED_REVIEW_REASONS.has(reason ?? "")
          ? `No approval in ${organization} predates the publication of this release. Drydock has an undecided review of these exact bytes: decide it, or investigate if nobody here published it.`
          : `No approval in ${organization} predates the publication of this release.${newestOnly}`,
      };
    case "published_despite_rejection":
      return reason === "rejected_after_publication"
        ? {
            title: `Rejected in ${organization} after it was published`,
            detail: `These exact bytes were rejected in ${organization} after they were published, and nothing here approved them.`,
          }
        : {
            title: `Published despite a rejection in ${organization}`,
            detail: `This release was published after it was rejected in ${organization}.`,
          };
    case "artifact_mismatch":
      return {
        title: `Published bytes differ from what ${organization} reviewed`,
        detail: `The published package bytes match no artifact reviewed in ${organization} for this version.${newestOnly}`,
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
  const { env, db, organizationId, packageName, version, status, reason } = input;
  const ownerUserId = await getOrganizationOwnerUserId(db, organizationId);
  if (!ownerUserId) {
    emitOperationalEvent("warn", "publication_alert.no_owner", { organizationId, packageName });
    return "failed";
  }
  const organizationName = await getOrganizationName(db, organizationId);
  const { title, detail } = describe(status, reason, organizationName ?? "your organization");
  const release = `${packageName}@${version}`;
  const link = packageUrl(env, packageName, organizationId);
  return deliverOrganizationNotification(env, db, {
    organizationId,
    ownerUserId,
    eventPrefix: "scan",
    eventMetadata: {
      trigger: "publication_discrepancy",
      packageName,
      version,
      status,
      ...(reason ? { reason } : {}),
    },
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

export interface NotifyPublicationCoverageGapInput {
  env: Cloudflare.Env;
  db: AppDb;
  organizationId: string;
  packageName: string;
  /** The release that could not be verified; null when no release of the package could be. */
  version: string | null;
  reason: string;
}

const coverageGapDetails: Record<string, string> = {
  registry_metadata_too_large:
    "npm's document for this package is larger than Drydock reads, so its new releases cannot be compared.",
  publication_history_limit:
    "the package has more versions than Drydock compares, so its new releases cannot be compared.",
  registry_evidence_unavailable:
    "npm's document for this package has not been readable for over an hour, so its new releases cannot be compared.",
  invalid_version_metadata:
    "npm lists a version of this package that Drydock cannot read as a version, so that release cannot be compared.",
  artifact_too_large:
    "the published tarball is larger than Drydock hashes, and npm's shasum cannot be compared with this organization's records of it.",
  artifact_timeout: "the published tarball has repeatedly failed to download in time.",
  artifact_unavailable: "the published tarball has repeatedly failed to download.",
  artifact_identity_invalid: "npm's metadata for this release names no valid tarball on npm.",
};

/**
 * Tell the organization the monitor could not establish a verdict for a
 * release (or any release of a package) for a reason another check will not
 * fix by itself. This is a coverage notice, not a discrepancy: nothing was
 * found wrong, and the wording must not suggest otherwise.
 */
export async function notifyPublicationCoverageGap(
  input: NotifyPublicationCoverageGapInput,
): Promise<NotificationDeliveryOutcome> {
  const { env, db, organizationId, packageName, version, reason } = input;
  const ownerUserId = await getOrganizationOwnerUserId(db, organizationId);
  if (!ownerUserId) {
    emitOperationalEvent("warn", "publication_alert.no_owner", { organizationId, packageName });
    return "failed";
  }
  const organizationName = await getOrganizationName(db, organizationId);
  const organization = organizationName ?? "your organization";
  const subject = version ? `${packageName}@${version}` : `releases of ${packageName}`;
  const title = `Drydock could not verify ${subject} against ${organization}'s reviews`;
  const detail = coverageGapDetails[reason] ?? "the comparison could not be completed.";
  const link = packageUrl(env, packageName, organizationId);
  return deliverOrganizationNotification(env, db, {
    organizationId,
    ownerUserId,
    eventPrefix: "scan",
    eventMetadata: { trigger: "publication_coverage_gap", packageName, version, reason },
    email: {
      subject: title,
      lines: [
        "Hi there,",
        "",
        `${title}: ${detail}`,
        organizationName ? `Organization: ${organizationName}` : null,
        "",
        "This is not a discrepancy: Drydock has found nothing wrong with this release. It could not complete the comparison, so the release is not covered until it can.",
        link ? `Package: ${link}` : null,
        "",
        "— Drydock",
      ],
    },
    slack: {
      title,
      packageLabel: version ? `${packageName}@${version}` : packageName,
      source: "publication monitor",
      statusLine: detail,
      dashboardUrl: link,
    },
  });
}
