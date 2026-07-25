import { type AppDb } from "../../db/client";
import { recordScanEvent } from "../../db/events";
import {
  getOrganizationName,
  getOrganizationOwnerUserId,
  resolveNotificationEmails,
} from "../../db/organizations";
import { getScan } from "../../db/scans";
import { getSlackConnectionSecret } from "../../db/slack-connection";
import { sendNotificationEmail } from "./email";
import { normalizeReleaseConsistency, type ReleaseConsistency } from "../scan/release-memory";
import type { RiskLevel } from "../review";
import type { OrganizationRole } from "../auth/roles";
import { decryptSlackBotToken } from "../platform/secret-box";
import {
  postSlackMessage,
  renderSlackMessage,
  type SlackDeliveryResult,
  type SlackNotificationPayload,
} from "./slack";

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
  const notificationOwnerUserId =
    (await getOrganizationOwnerUserId(db, organizationId)) ?? ownerUserId;
  const [recipients, detail, organizationName] = await Promise.all([
    resolveNotificationEmails(db, organizationId, notificationOwnerUserId),
    getScan(db, scanId, organizationId),
    getOrganizationName(db, organizationId),
  ]);

  const scan = detail?.scan;
  const packageLabel = formatPackageLabel(scan?.packageName, scan?.stagedVersion);
  const dashboardUrl = scanUrl(env, scanId, organizationId);
  const releaseRisk = detail?.riskSummary?.releaseRisk ?? scan?.risk ?? null;
  const releaseMemory = formatReleaseMemory(scan?.summaryJson);
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
          organizationName ? `Organization: ${organizationName}` : null,
          releaseRisk ? `Release risk: ${releaseRisk}.` : null,
          releaseMemory ? `Release memory: ${releaseMemory}` : null,
          dashboardUrl ? `Review the report: ${dashboardUrl}` : null,
          "",
          "— Drydock",
        ]
      : [
          "Hi there,",
          "",
          `We could not complete the staged release scan for ${packageLabel}.`,
          organizationName ? `Organization: ${organizationName}` : null,
          error?.message ? `Reason: ${error.message}` : null,
          dashboardUrl ? `Review the scan: ${dashboardUrl}` : null,
          "",
          "— Drydock",
        ];
  const text = lines.filter((line): line is string => line !== null).join("\n");

  const slackPayload: SlackNotificationPayload = {
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
  };

  const emailDelivery = (async () => {
    if (recipients.length === 0) {
      await recordScanEvent(db, {
        organizationId,
        actorUserId: notificationOwnerUserId,
        scanId,
        type: "scan.notification_failed",
        metadata: { outcome, channel: "email", reason: "no_recipients" },
      });
      return;
    }
    await deliverToRecipients(env, db, recipients, { subject, text }, (recipient, result) => ({
      organizationId,
      actorUserId: notificationOwnerUserId,
      scanId,
      type: result.ok ? "scan.notification_sent" : "scan.notification_failed",
      metadata: {
        outcome,
        channel: "email",
        recipient,
        ...(result.ok ? {} : { reason: result.reason }),
      },
    }));
  })();

  const slackDelivery = deliverToSlackConnection(
    env,
    db,
    { organizationId, actorUserId: notificationOwnerUserId, scanId },
    slackPayload,
    (channel, result) => ({
      organizationId,
      actorUserId: notificationOwnerUserId,
      scanId,
      type: result.ok ? "scan.notification_sent" : "scan.notification_failed",
      metadata: slackEventMetadata({ outcome }, channel, result),
    }),
  );

  await Promise.all([emailDelivery, slackDelivery]);
}

function formatReleaseMemory(summaryJson: unknown): string | null {
  if (!summaryJson || typeof summaryJson !== "object" || Array.isArray(summaryJson)) return null;
  const consistency = normalizeReleaseConsistency(
    (summaryJson as { releaseConsistency?: unknown }).releaseConsistency,
  );
  if (!consistency || consistency.status === "none") return null;

  const prior = priorReleaseLabel(consistency);
  if (consistency.status === "diverged") {
    const count = consistency.newFindingCount;
    return `${count} new deterministic ${count === 1 ? "finding" : "findings"} since ${prior}.`;
  }
  if (consistency.currentFindingCount === 0) {
    return `No deterministic findings; compared with ${prior}, which was already reviewed and published.`;
  }
  if (consistency.status === "subset") {
    return `No new deterministic findings since ${prior}; every current finding was already reviewed and published.`;
  }
  return `Finding profile matches ${prior}; the same deterministic findings were already reviewed and published.`;
}

function priorReleaseLabel(consistency: ReleaseConsistency): string {
  return consistency.priorVersion ? `v${consistency.priorVersion}` : "the last approved release";
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
 * per recipient. Delivery is best-effort: each send is recorded as an
 * `npm_connection.notification_sent` / `notification_failed` event and never
 * throws back into the sweep. The body carries only the registry URL and a
 * Settings link; no token material ever reaches the email.
 */
export async function notifyNpmConnectionExpired(
  input: NotifyNpmConnectionExpiredInput,
): Promise<void> {
  const { env, db, organizationId, ownerUserId, registryUrl } = input;
  const [recipients, organizationName] = await Promise.all([
    resolveNotificationEmails(db, organizationId, ownerUserId),
    getOrganizationName(db, organizationId),
  ]);
  if (recipients.length === 0) {
    await recordScanEvent(db, {
      organizationId,
      actorUserId: ownerUserId,
      type: "npm_connection.notification_failed",
      metadata: { channel: "email", trigger: "token_expired", reason: "no_recipients" },
    });
    return;
  }

  // A recipient can watch several organizations from one inbox, so name the org
  // in both the body and the link — otherwise "your organization" leaves them
  // guessing which token to replace and lands them on whatever org their browser
  // last had active.
  const orgLabel = organizationName ?? "your organization";
  const settingsLink = settingsUrl(env, organizationId);
  const subject = "Your npm token can no longer reach the staging registry";
  const lines = [
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
  ];
  const text = lines.filter((line): line is string => line !== null).join("\n");

  await deliverToRecipients(env, db, recipients, { subject, text }, (recipient, result) => ({
    organizationId,
    actorUserId: ownerUserId,
    type: result.ok ? "npm_connection.notification_sent" : "npm_connection.notification_failed",
    metadata: {
      channel: "email",
      trigger: "token_expired",
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
  /** Total packages in the release; >1 means a monorepo bundle fanned out. */
  packageCount?: number;
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
    packageCount,
  } = input;

  const [recipients, organizationName] = await Promise.all([
    resolveNotificationEmails(db, organizationId, ownerUserId),
    getOrganizationName(db, organizationId),
  ]);

  const packageLabel = formatPackageLabel(packageName, version);
  const dashboardUrl = scanUrl(env, scanId, organizationId);
  const otherPackages = packageCount && packageCount > 1 ? packageCount - 1 : 0;
  // A monorepo release fans out into several per-package scans behind one gate;
  // the gate carries only its headline (highest-risk) package. Surface the bundle
  // size in every channel so the headline isn't mistaken for the whole release —
  // each package must be approved before the held deployment can publish.
  const packageDisplay = otherPackages
    ? `${packageLabel} (+${otherPackages} more in this release; each must be approved)`
    : packageLabel;
  const packageLine = `Package: ${packageDisplay}`;
  const subject = `Release gate needs your review — ${packageLabel}`;
  const lines = [
    "Hi there,",
    "",
    `A staged release is held in ${repositoryFullName} and is waiting for a decision before it can publish.`,
    "",
    organizationName ? `Organization: ${organizationName}` : null,
    packageLine,
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

  const slackPayload: SlackNotificationPayload = {
    title: "Release gate needs a decision",
    packageLabel: packageDisplay,
    source: "GitHub workflow gate",
    risk: releaseRisk,
    repository: repositoryFullName,
    environment,
    statusLine: `Held in ${repositoryFullName} — the deployment stays blocked until someone approves or rejects it.`,
    dashboardUrl,
  };

  const emailDelivery = (async () => {
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
  })();

  const slackDelivery = deliverToSlackConnection(
    env,
    db,
    { organizationId, actorUserId: ownerUserId, scanId },
    slackPayload,
    (channel, result) => ({
      organizationId,
      actorUserId: ownerUserId,
      scanId,
      type: result.ok
        ? "github_workflow_gate.notification_sent"
        : "github_workflow_gate.notification_failed",
      metadata: slackEventMetadata({ gateId, releaseRisk }, channel, result),
    }),
  );

  await Promise.all([emailDelivery, slackDelivery]);
}

export interface NotifyWorkflowGateTimeoutInput {
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
}

/**
 * Email the organization's notification recipients that a workflow gate review
 * did not finish inside GitHub's deployment-protection callback window. By the
 * time we detect this the release was likely already auto-rejected by GitHub, so
 * — unlike `notifyWorkflowGateReview` — this email does not ask for an
 * approve/block decision; it reports the timeout and points at the now-completed
 * review. Delivery is best-effort and recorded as
 * `github_workflow_gate.notification_sent` / `notification_failed`.
 */
export async function notifyWorkflowGateTimeout(
  input: NotifyWorkflowGateTimeoutInput,
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
  } = input;

  const [recipients, organizationName] = await Promise.all([
    resolveNotificationEmails(db, organizationId, ownerUserId),
    getOrganizationName(db, organizationId),
  ]);
  if (recipients.length === 0) {
    await recordScanEvent(db, {
      organizationId,
      actorUserId: ownerUserId,
      scanId,
      type: "github_workflow_gate.notification_failed",
      metadata: { gateId, channel: "email", trigger: "timeout_missed", reason: "no_recipients" },
    });
    return;
  }

  const packageLabel = formatPackageLabel(packageName, version);
  const dashboardUrl = scanUrl(env, scanId, organizationId);
  const subject = `GitHub gate for ${packageLabel} timed out before scan completed`;
  const lines = [
    "Hi there,",
    "",
    `The GitHub release gate for ${packageLabel} in ${repositoryFullName} timed out before Drydock finished scanning it.`,
    "GitHub may have already blocked the release because the review did not return inside its decision window.",
    "",
    organizationName ? `Organization: ${organizationName}` : null,
    `Repository: ${repositoryFullName}`,
    `Environment: ${environment}`,
    "",
    dashboardUrl ? `See the completed review: ${dashboardUrl}` : null,
    "",
    "Re-run the workflow to request a fresh review.",
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
      trigger: "timeout_missed",
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

interface SlackDeliveryChannel {
  channelId: string;
  channelName: string | null;
}

/**
 * Post a rendered Slack message to the organization's single connected channel.
 * Best-effort and isolated from email: if there is no connection, it's disabled,
 * or no channel has been chosen, we silently skip. A failing post only records a
 * `notification_failed` event and never throws, so it cannot block scan
 * completion or workflow-gate processing. The bot token is decrypted only in
 * memory for the POST and never enters the recorded event metadata.
 */
async function deliverToSlackConnection(
  env: Cloudflare.Env,
  db: AppDb,
  context: { organizationId: string; actorUserId: string; scanId: string },
  payload: SlackNotificationPayload,
  event: (
    channel: SlackDeliveryChannel,
    result: SlackDeliveryResult,
  ) => Parameters<typeof recordScanEvent>[1],
): Promise<void> {
  const connection = await getSlackConnectionSecret(db, context.organizationId);
  if (!connection || !connection.enabled || !connection.channelId) return;
  const channel: SlackDeliveryChannel = {
    channelId: connection.channelId,
    channelName: connection.channelName,
  };
  let result: SlackDeliveryResult;
  try {
    const botToken = await decryptSlackBotToken(env, {
      ciphertext: connection.botTokenCiphertext,
      nonce: connection.botTokenNonce,
    });
    result = await postSlackMessage(botToken, connection.channelId, renderSlackMessage(payload));
  } catch {
    result = { ok: false, statusClass: "other", reason: "delivery_error" };
  }
  await recordScanEvent(db, event(channel, result));
}

function slackEventMetadata(
  base: Record<string, unknown>,
  channel: SlackDeliveryChannel,
  result: SlackDeliveryResult,
): Record<string, unknown> {
  return {
    ...base,
    channel: "slack",
    channelName: channel.channelName,
    ...(result.statusClass ? { statusClass: result.statusClass } : {}),
    ...(result.rateLimited
      ? { rateLimited: true, retryAfterSeconds: result.retryAfterSeconds ?? null }
      : {}),
    ...(result.ok ? {} : { reason: result.reason }),
  };
}

function formatFindingsSummary(
  riskSummary: { releaseFindingCount: number; contextFindingCount: number } | null | undefined,
): string | null {
  if (!riskSummary) return null;
  const total = riskSummary.releaseFindingCount + riskSummary.contextFindingCount;
  if (total === 0) return "No findings";
  return `${total} findings (${riskSummary.releaseFindingCount} on the release diff)`;
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

function scanUrl(env: Cloudflare.Env, scanId: string, organizationId?: string): string | null {
  const base = env.BETTER_AUTH_URL;
  if (typeof base !== "string" || !base) return null;
  try {
    const url = new URL(`/dashboard/scans/${encodeURIComponent(scanId)}`, base);
    if (organizationId) url.searchParams.set("org", organizationId);
    return url.toString();
  } catch {
    return null;
  }
}

function settingsUrl(env: Cloudflare.Env, organizationId?: string): string | null {
  const base = env.BETTER_AUTH_URL;
  if (typeof base !== "string" || !base) return null;
  try {
    const url = new URL("/dashboard/settings", base);
    url.searchParams.set("tab", "integrations");
    if (organizationId) url.searchParams.set("org", organizationId);
    return url.toString();
  } catch {
    return null;
  }
}
