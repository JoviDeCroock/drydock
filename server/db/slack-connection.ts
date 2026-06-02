import { eq } from "drizzle-orm";
import type { AppDb } from "./client";
import { organizationSlackConnections } from "./schema";

export interface SlackConnection {
  id: string;
  organizationId: string;
  teamId: string;
  teamName: string | null;
  botUserId: string | null;
  channelId: string | null;
  channelName: string | null;
  enabled: boolean;
  createdAt: Date | string | number;
  updatedAt: Date | string | number;
}

export interface SlackConnectionSecret {
  id: string;
  organizationId: string;
  teamId: string;
  teamName: string | null;
  channelId: string | null;
  channelName: string | null;
  enabled: boolean;
  botTokenCiphertext: string;
  botTokenNonce: string;
}

const PUBLIC_COLUMNS = {
  id: organizationSlackConnections.id,
  organizationId: organizationSlackConnections.organizationId,
  teamId: organizationSlackConnections.teamId,
  teamName: organizationSlackConnections.teamName,
  botUserId: organizationSlackConnections.botUserId,
  channelId: organizationSlackConnections.channelId,
  channelName: organizationSlackConnections.channelName,
  enabled: organizationSlackConnections.enabled,
  createdAt: organizationSlackConnections.createdAt,
  updatedAt: organizationSlackConnections.updatedAt,
};

export async function getSlackConnection(
  db: AppDb,
  organizationId: string,
): Promise<SlackConnection | null> {
  const [row] = await db
    .select(PUBLIC_COLUMNS)
    .from(organizationSlackConnections)
    .where(eq(organizationSlackConnections.organizationId, organizationId))
    .limit(1);
  return row ?? null;
}

/**
 * Return the encrypted bot token plus delivery state for an org's Slack
 * connection. Kept separate from the public read so the token ciphertext never
 * leaks into list/status responses. Used by the notifier and the test send.
 */
export async function getSlackConnectionSecret(
  db: AppDb,
  organizationId: string,
): Promise<SlackConnectionSecret | null> {
  const [row] = await db
    .select({
      id: organizationSlackConnections.id,
      organizationId: organizationSlackConnections.organizationId,
      teamId: organizationSlackConnections.teamId,
      teamName: organizationSlackConnections.teamName,
      channelId: organizationSlackConnections.channelId,
      channelName: organizationSlackConnections.channelName,
      enabled: organizationSlackConnections.enabled,
      botTokenCiphertext: organizationSlackConnections.botTokenCiphertext,
      botTokenNonce: organizationSlackConnections.botTokenNonce,
    })
    .from(organizationSlackConnections)
    .where(eq(organizationSlackConnections.organizationId, organizationId))
    .limit(1);
  return row ?? null;
}

export interface UpsertSlackConnectionInput {
  organizationId: string;
  teamId: string;
  teamName: string | null;
  botUserId: string | null;
  scope: string | null;
  botTokenCiphertext: string;
  botTokenNonce: string;
  createdByUserId: string | null;
}

/**
 * Create or replace the org's single Slack connection after an OAuth exchange.
 * Reconnecting the same workspace keeps the chosen channel; reconnecting a
 * different workspace clears it (the channel id belonged to the old team).
 */
export async function upsertSlackConnection(
  db: AppDb,
  input: UpsertSlackConnectionInput,
): Promise<SlackConnection> {
  const now = new Date();
  const existing = await getSlackConnection(db, input.organizationId);
  const keepChannel = existing && existing.teamId === input.teamId;

  if (existing) {
    const [updated] = await db
      .update(organizationSlackConnections)
      .set({
        teamId: input.teamId,
        teamName: input.teamName,
        botUserId: input.botUserId,
        scope: input.scope,
        botTokenCiphertext: input.botTokenCiphertext,
        botTokenNonce: input.botTokenNonce,
        channelId: keepChannel ? existing.channelId : null,
        channelName: keepChannel ? existing.channelName : null,
        enabled: true,
        updatedAt: now,
      })
      .where(eq(organizationSlackConnections.organizationId, input.organizationId))
      .returning(PUBLIC_COLUMNS);
    return updated;
  }

  const [created] = await db
    .insert(organizationSlackConnections)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      teamId: input.teamId,
      teamName: input.teamName,
      botUserId: input.botUserId,
      scope: input.scope,
      botTokenCiphertext: input.botTokenCiphertext,
      botTokenNonce: input.botTokenNonce,
      channelId: null,
      channelName: null,
      enabled: true,
      createdByUserId: input.createdByUserId,
      createdAt: now,
      updatedAt: now,
    })
    .returning(PUBLIC_COLUMNS);
  return created;
}

export async function setSlackConnectionChannel(
  db: AppDb,
  organizationId: string,
  channel: { channelId: string; channelName: string | null },
): Promise<SlackConnection | null> {
  const [updated] = await db
    .update(organizationSlackConnections)
    .set({
      channelId: channel.channelId,
      channelName: channel.channelName,
      updatedAt: new Date(),
    })
    .where(eq(organizationSlackConnections.organizationId, organizationId))
    .returning(PUBLIC_COLUMNS);
  return updated ?? null;
}

export async function setSlackConnectionEnabled(
  db: AppDb,
  organizationId: string,
  enabled: boolean,
): Promise<SlackConnection | null> {
  const [updated] = await db
    .update(organizationSlackConnections)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(organizationSlackConnections.organizationId, organizationId))
    .returning(PUBLIC_COLUMNS);
  return updated ?? null;
}

export async function deleteSlackConnection(
  db: AppDb,
  organizationId: string,
): Promise<SlackConnection | null> {
  const [removed] = await db
    .delete(organizationSlackConnections)
    .where(eq(organizationSlackConnections.organizationId, organizationId))
    .returning(PUBLIC_COLUMNS);
  return removed ?? null;
}
