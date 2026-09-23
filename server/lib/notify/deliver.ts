import { type AppDb } from "../../db/client";
import { recordScanEvent } from "../../db/events";
import { getOrganizationOwnerUserId, resolveNotificationEmails } from "../../db/organizations";
import { getSlackConnectionSecret } from "../../db/slack-connection";
import { decryptSlackBotToken } from "../platform/secret-box";
import { sendNotificationEmail } from "./email";
import {
  postSlackMessage,
  renderSlackMessage,
  type SlackDeliveryResult,
  type SlackNotificationPayload,
} from "./slack";

/**
 * What a fan-out achieved. `delivered`: some recipient or channel accepted it.
 * `failed`: somewhere to send existed but nothing accepted it, so a retry may
 * succeed. `no_destination`: no recipient resolved, no transport can reach one,
 * and no Slack channel is connected, so retrying cannot change anything.
 */
export type NotificationDeliveryOutcome = "delivered" | "failed" | "no_destination";

export interface OrganizationNotification {
  organizationId: string;
  /**
   * Who the caller was acting as. Recipients and the recorded actor are
   * resolved to the organization owner when one exists; this is only the
   * fallback for an organization whose owner row is gone.
   */
  ownerUserId: string;
  scanId?: string;
  /** `scan`, `npm_connection`, or `github_workflow_gate`: the event family. */
  eventPrefix: string;
  /** Spread into every delivery event's metadata (outcome, trigger, gateId, ...). */
  eventMetadata: Record<string, unknown>;
  /** Null lines are dropped; the rest join with newlines. */
  email: { subject: string; lines: (string | null)[] } | null;
  slack: SlackNotificationPayload | null;
}

/**
 * Fan an organization notification out to its email recipients and its Slack
 * channel, recording one `<prefix>.notification_sent` / `notification_failed`
 * event per delivery. Every path is best-effort: nothing here throws back into
 * a scan job, gate job, or discovery sweep.
 *
 * The two channels are independent. Slack still fires when no email recipients
 * resolve (that case records a single `no_recipients` failure), and an email
 * failure never suppresses the Slack post. The event actor is the organization
 * owner rather than whoever triggered the work (a cron sweep, an on-demand
 * button, a GitHub webhook), so the audit trail names the account the
 * notification is addressed to.
 *
 * Returns the combined per-channel outcome for callers that must know whether
 * anyone was actually reached; the per-delivery events are recorded either way.
 */
export async function deliverOrganizationNotification(
  env: Cloudflare.Env,
  db: AppDb,
  notification: OrganizationNotification,
): Promise<NotificationDeliveryOutcome> {
  const { organizationId, scanId, eventPrefix, eventMetadata } = notification;
  const actorUserId =
    (await getOrganizationOwnerUserId(db, organizationId)) ?? notification.ownerUserId;
  const eventBase = { organizationId, actorUserId, ...(scanId ? { scanId } : {}) };
  const sent = `${eventPrefix}.notification_sent`;
  const failed = `${eventPrefix}.notification_failed`;

  const emailDelivery = (async (): Promise<NotificationDeliveryOutcome> => {
    if (!notification.email) return "no_destination";
    const recipients = await resolveNotificationEmails(db, organizationId, actorUserId);
    if (recipients.length === 0) {
      await recordScanEvent(db, {
        ...eventBase,
        type: failed,
        metadata: { ...eventMetadata, channel: "email", reason: "no_recipients" },
      });
      return "no_destination";
    }
    const { subject, lines } = notification.email;
    const text = lines.filter((line): line is string => line !== null).join("\n");
    const results = await Promise.all(
      recipients.map(async (recipient) => {
        const result = await sendNotificationEmail(env, { to: recipient, subject, text });
        await recordScanEvent(db, {
          ...eventBase,
          type: result.ok ? sent : failed,
          metadata: {
            ...eventMetadata,
            channel: "email",
            recipient,
            ...(result.ok ? {} : { reason: result.reason }),
          },
        });
        return result;
      }),
    );
    if (results.some((result) => result.ok)) return "delivered";
    return results.every((result) => result.undeliverable) ? "no_destination" : "failed";
  })();

  const slackDelivery = (async (): Promise<NotificationDeliveryOutcome> => {
    if (!notification.slack) return "no_destination";
    const delivery = await deliverToSlackConnection(env, db, organizationId, notification.slack);
    if (!delivery) return "no_destination";
    await recordScanEvent(db, {
      ...eventBase,
      type: delivery.result.ok ? sent : failed,
      metadata: slackEventMetadata(eventMetadata, delivery.channelName, delivery.result),
    });
    if (delivery.result.ok) return "delivered";
    return slackFailureIsPermanent(delivery.result) ? "no_destination" : "failed";
  })();

  const outcomes = await Promise.all([emailDelivery, slackDelivery]);
  if (outcomes.includes("delivered")) return "delivered";
  return outcomes.includes("failed") ? "failed" : "no_destination";
}

/**
 * Post a rendered Slack message to the organization's single connected channel.
 * Returns null (nothing to record) when there is no connection, it is disabled,
 * or no channel has been chosen. A failing post is returned as a result, never
 * thrown. The bot token is decrypted only in memory for the POST and never
 * enters the returned value.
 */
async function deliverToSlackConnection(
  env: Cloudflare.Env,
  db: AppDb,
  organizationId: string,
  payload: SlackNotificationPayload,
): Promise<{ channelName: string | null; result: SlackDeliveryResult } | null> {
  const connection = await getSlackConnectionSecret(db, organizationId);
  if (!connection || !connection.enabled || !connection.channelId) return null;
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
  return { channelName: connection.channelName, result };
}

// Slack errors a resend cannot fix: the connection or channel itself is gone
// or unusable until someone reconnects it. Treating them as retryable would
// re-post every pending alert on every check forever.
const PERMANENT_SLACK_ERRORS = new Set([
  "missing_credentials",
  "delivery_error",
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "no_permission",
  "missing_scope",
  "channel_not_found",
  "is_archived",
  "not_in_channel",
]);

function slackFailureIsPermanent(result: SlackDeliveryResult): boolean {
  return !result.rateLimited && PERMANENT_SLACK_ERRORS.has(result.reason ?? "");
}

function slackEventMetadata(
  base: Record<string, unknown>,
  channelName: string | null,
  result: SlackDeliveryResult,
): Record<string, unknown> {
  return {
    ...base,
    channel: "slack",
    channelName,
    ...(result.statusClass ? { statusClass: result.statusClass } : {}),
    ...(result.rateLimited
      ? { rateLimited: true, retryAfterSeconds: result.retryAfterSeconds ?? null }
      : {}),
    ...(result.ok ? {} : { reason: result.reason }),
  };
}
