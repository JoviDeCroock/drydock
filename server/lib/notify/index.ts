import { type AppDb } from "../../db/client";
import { getOrganizationName } from "../../db/organizations";
import { getScan } from "../../db/scans";
import { isValidStageId } from "../ecosystems/npm/stage-id";
import { isSafeHttpUrlForShellArgument, quotePosixShellArgument } from "../platform/shell-command";
import { deliverOrganizationNotification } from "./deliver";
import {
  formatFindingsSummary,
  formatPackageLabel,
  formatReleaseMemory,
  formatTimestamp,
} from "./format";
import { scanUrl, settingsUrl } from "./links";

export { notifyWorkflowGateReview, notifyWorkflowGateTimeout } from "./gate-notifications";
export { notifyOrganizationInvite } from "./organization-invite";
export { notifyPublicationCoverageGap, notifyPublicationDiscrepancy } from "./publication-alerts";

// The staged-publish notifiers below stay in this module because they render
// npm's `stage approve` command: `approvalInstructions` is the one place the
// notify layer speaks an ecosystem's grammar, and its stage-id import is
// allowlisted here by `test/ecosystem-branching-invariants.test.mjs`.

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
  const [detail, organizationName] = await Promise.all([
    getScan(db, scanId, organizationId),
    getOrganizationName(db, organizationId),
  ]);

  const scan = detail?.scan;
  const packageLabel = formatPackageLabel(scan?.packageName, scan?.stagedVersion);
  const dashboardUrl = scanUrl(env, scanId, organizationId);
  const releaseRisk = detail?.riskSummary?.releaseRisk ?? scan?.risk ?? null;
  const releaseMemory = formatReleaseMemory(scan?.summaryJson);

  await deliverOrganizationNotification(env, db, {
    organizationId,
    ownerUserId,
    scanId,
    eventPrefix: "scan",
    eventMetadata: { outcome },
    email:
      outcome === "complete"
        ? {
            subject: `Staged release scan complete — ${packageLabel}`,
            lines: [
              "Hi there,",
              "",
              `We finished scanning the staged release ${packageLabel}.`,
              organizationName ? `Organization: ${organizationName}` : null,
              releaseRisk ? `Release risk: ${releaseRisk}.` : null,
              releaseMemory ? `Release memory: ${releaseMemory}` : null,
              dashboardUrl ? `Review the report: ${dashboardUrl}` : null,
              "",
              "— Drydock",
            ],
          }
        : {
            subject: `Staged release scan failed — ${packageLabel}`,
            lines: [
              "Hi there,",
              "",
              `We could not complete the staged release scan for ${packageLabel}.`,
              organizationName ? `Organization: ${organizationName}` : null,
              error?.message ? `Reason: ${error.message}` : null,
              dashboardUrl ? `Review the scan: ${dashboardUrl}` : null,
              "",
              "— Drydock",
            ],
          },
    slack: {
      title: outcome === "complete" ? "Staged release scan complete" : "Staged release scan failed",
      packageLabel,
      source: "npm staged publish",
      risk: releaseRisk,
      findingsSummary: formatFindingsSummary(detail?.riskSummary),
      releaseMemory,
      statusLine:
        outcome === "failed"
          ? error?.message
            ? `Could not finish the scan: ${error.message}`
            : "Could not finish the scan."
          : null,
      dashboardUrl,
    },
  });
}

export interface NotifyNpmConnectionExpiredInput {
  env: Cloudflare.Env;
  db: AppDb;
  organizationId: string;
  ownerUserId: string;
  registryUrl: string;
}

/**
 * Email the organization's notification recipients that Drydock can no longer
 * reach the staging registry with their saved npm token, so staged-release
 * reviews have stopped. This is the only proactive signal that the system meant
 * to watch their publishes has silently stopped watching them.
 *
 * The caller (`recordExpiredNpmConnection`) marks the connection `invalid`
 * before this runs, which both drives the Settings banner and removes the
 * connection from the cron sweep — so a single expiry produces a single email
 * per recipient. The body carries only the registry URL and a Settings link;
 * no token material ever reaches the email.
 */
export async function notifyNpmConnectionExpired(
  input: NotifyNpmConnectionExpiredInput,
): Promise<void> {
  const { env, db, organizationId, ownerUserId, registryUrl } = input;
  const organizationName = await getOrganizationName(db, organizationId);

  // A recipient can watch several organizations from one inbox, so name the org
  // in both the body and the link — otherwise "your organization" leaves them
  // guessing which token to replace and lands them on whatever org their browser
  // last had active.
  const orgLabel = organizationName ?? "your organization";
  const settingsLink = settingsUrl(env, organizationId);

  await deliverOrganizationNotification(env, db, {
    organizationId,
    ownerUserId,
    eventPrefix: "npm_connection",
    eventMetadata: { trigger: "token_expired" },
    email: {
      subject: "Your npm token can no longer reach the staging registry",
      lines: [
        "Hi there,",
        "",
        `Drydock can no longer reach the npm staging registry with the saved token for ${orgLabel}, so staged-release reviews are paused.`,
        "",
        organizationName ? `Organization: ${organizationName}` : null,
        `Registry: ${registryUrl}`,
        "",
        settingsLink
          ? `Re-add a working token on Settings to resume reviews: ${settingsLink}`
          : "Re-add a working token on the Settings page to resume reviews.",
        "",
        "— Drydock",
      ],
    },
    slack: null,
  });
}

export interface NotifyStagedReleaseAwaitingApprovalInput {
  env: Cloudflare.Env;
  db: AppDb;
  organizationId: string;
  ownerUserId: string;
  scanId: string;
  stageId: string;
  packageName: string;
  version: string;
  decidedAt: Date | string | number | null;
  registryUrl: string;
}

/**
 * Email the organization that a release it approved in Drydock is still sitting
 * staged on npm.
 *
 * Approving here records a decision; it does not publish anything. The gap
 * between the two is easy to lose — the reviewer finishes in Drydock, closes
 * the tab, and the version never ships because npm's own approve was never run.
 * This is the only signal that closes it, and it is deliberately worded as a
 * reminder rather than a failure: nothing is wrong, something is unfinished.
 *
 * Send-once is owned by the caller, which claims the row's reminder marker
 * before calling. The body carries release identity and a dashboard link only —
 * no token, header, or package bytes.
 */
export async function notifyStagedReleaseAwaitingApproval(
  input: NotifyStagedReleaseAwaitingApprovalInput,
): Promise<void> {
  const { env, db, organizationId, ownerUserId, scanId, stageId, packageName, version } = input;
  const organizationName = await getOrganizationName(db, organizationId);

  const release = `${packageName}@${version}`;
  const link = scanUrl(env, scanId, organizationId);
  const decidedLabel = formatTimestamp(input.decidedAt);

  await deliverOrganizationNotification(env, db, {
    organizationId,
    ownerUserId,
    scanId,
    eventPrefix: "scan",
    eventMetadata: { trigger: "awaiting_registry_approval" },
    email: {
      subject: `${release} is approved in Drydock but still staged on npm`,
      lines: [
        "Hi there,",
        "",
        `${release} was approved in Drydock${decidedLabel ? ` on ${decidedLabel}` : ""}, but npm still reports it as staged — so it has not been published yet.`,
        "",
        organizationName ? `Organization: ${organizationName}` : null,
        ...approvalInstructions(stageId, input.registryUrl),
        "",
        link ? `Review: ${link}` : null,
        "",
        "If you meant to leave it staged, no action is needed — this is sent once per release.",
        "",
        "— Drydock",
      ],
    },
    slack: null,
  });
}

export interface NotifyStagedReleaseApprovableInput {
  env: Cloudflare.Env;
  db: AppDb;
  organizationId: string;
  ownerUserId: string;
  scanId: string;
  stageId: string;
  packageName: string;
  version: string;
  decision: string | null;
  registryUrl: string;
}

/**
 * Tell the organization that npm has finished validating a staged release the
 * Drydock review already covers, so the maintainer can act now.
 *
 * npm holds `npm stage approve` until its own malware scan settles; a reviewer
 * who finished reading the diff while the version was still `validating` had
 * nothing to do but poll. This fires on the observed `validating` (or
 * never-known) to `staged` transition, once per registry release. Send-once is
 * owned by the caller, which claims the row's marker before calling. The body
 * carries release identity, Drydock's release-risk grade and finding count, a
 * dashboard link, and npm's approval command — no token, header, or package
 * bytes.
 */
export async function notifyStagedReleaseApprovable(
  input: NotifyStagedReleaseApprovableInput,
): Promise<void> {
  const { env, db, organizationId, ownerUserId, scanId, stageId, packageName, version } = input;
  const [organizationName, detail] = await Promise.all([
    getOrganizationName(db, organizationId),
    getScan(db, scanId, organizationId),
  ]);

  const release = `${packageName}@${version}`;
  const link = scanUrl(env, scanId, organizationId);
  const releaseRisk = detail?.riskSummary?.releaseRisk ?? detail?.scan.risk ?? null;
  const findingsSummary = formatFindingsSummary(detail?.riskSummary);
  const decisionLine =
    input.decision === "publish"
      ? "Drydock decision: publish — approved here, waiting on npm's own approval."
      : input.decision === "no_publish"
        ? "Drydock decision: do not publish — recorded here; nothing on npm changes until someone approves the stage."
        : "Drydock decision: none recorded yet.";
  const instructions = approvalInstructions(stageId, input.registryUrl);

  await deliverOrganizationNotification(env, db, {
    organizationId,
    ownerUserId,
    scanId,
    eventPrefix: "scan",
    eventMetadata: { trigger: "registry_approvable" },
    email: {
      subject: `${release} is ready to approve on npm`,
      lines: [
        "Hi there,",
        "",
        `npm has finished validating ${release}. The stage can be approved now; until a maintainer does, nothing is published.`,
        "",
        organizationName ? `Organization: ${organizationName}` : null,
        releaseRisk ? `Release risk: ${releaseRisk}.` : null,
        findingsSummary ? `Findings: ${findingsSummary}.` : null,
        decisionLine,
        ...instructions,
        "",
        link ? `Review: ${link}` : null,
        "",
        "This is sent once per release, when npm's status first allows approval.",
        "",
        "— Drydock",
      ],
    },
    slack: {
      title: "Staged release ready to approve on npm",
      packageLabel: release,
      source: "npm staged publish",
      risk: releaseRisk,
      findingsSummary,
      recommendation: decisionLine,
      statusLine: [
        `npm finished validating ${release}; the stage can be approved now.`,
        ...instructions.filter((line) => line.trimStart().startsWith("npm stage approve")),
      ].join("\n"),
      dashboardUrl: link,
    },
  });
}

/**
 * The "finish the publish" block, or nothing.
 *
 * The instruction and the command it introduces stand or fall together — a
 * "run npm's own approval:" with no command under it reads like a truncated
 * email. The id is validated rather than interpolated raw because this line is
 * meant to be pasted into a shell, so registry-supplied text must never reach
 * one with shell metacharacters intact.
 */
function approvalInstructions(stageId: string, registryUrl: string): string[] {
  if (!isValidStageId(stageId) || !isSafeHttpUrlForShellArgument(registryUrl)) return [];
  return [
    `Stage: ${stageId}`,
    "",
    "Drydock never publishes on your behalf. To finish the release, run npm's own approval:",
    "",
    `  npm stage approve ${stageId} --registry ${quotePosixShellArgument(registryUrl)}`,
  ];
}
