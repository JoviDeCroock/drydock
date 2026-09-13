import { eq } from "drizzle-orm";
import type { AppDb } from "./client";
import { organizationWebhookConnections } from "./schema";

const PUBLIC_COLUMNS = {
  hostname: organizationWebhookConnections.hostname,
  enabled: organizationWebhookConnections.enabled,
  createdAt: organizationWebhookConnections.createdAt,
};

export async function getWebhookConnection(db: AppDb, organizationId: string) {
  const [row] = await db
    .select(PUBLIC_COLUMNS)
    .from(organizationWebhookConnections)
    .where(eq(organizationWebhookConnections.organizationId, organizationId))
    .limit(1);
  return row ?? null;
}

// Separate from status reads so encrypted credentials cannot enter API responses.
export async function getWebhookConnectionSecret(db: AppDb, organizationId: string) {
  const [row] = await db
    .select()
    .from(organizationWebhookConnections)
    .where(eq(organizationWebhookConnections.organizationId, organizationId))
    .limit(1);
  return row ?? null;
}

export async function upsertWebhookConnection(
  db: AppDb,
  input: {
    organizationId: string;
    hostname: string;
    credentialsCiphertext: string;
    credentialsNonce: string;
    createdByUserId: string | null;
  },
) {
  const now = new Date();
  const [row] = await db
    .insert(organizationWebhookConnections)
    .values({
      ...input,
      id: crypto.randomUUID(),
      enabled: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: organizationWebhookConnections.organizationId,
      set: {
        hostname: input.hostname,
        credentialsCiphertext: input.credentialsCiphertext,
        credentialsNonce: input.credentialsNonce,
        enabled: true,
        updatedAt: now,
      },
    })
    .returning(PUBLIC_COLUMNS);
  return row;
}

export async function setWebhookConnectionEnabled(
  db: AppDb,
  organizationId: string,
  enabled: boolean,
) {
  const [row] = await db
    .update(organizationWebhookConnections)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(organizationWebhookConnections.organizationId, organizationId))
    .returning(PUBLIC_COLUMNS);
  return row ?? null;
}

export async function deleteWebhookConnection(db: AppDb, organizationId: string) {
  const [row] = await db
    .delete(organizationWebhookConnections)
    .where(eq(organizationWebhookConnections.organizationId, organizationId))
    .returning(PUBLIC_COLUMNS);
  return row ?? null;
}
