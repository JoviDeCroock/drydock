import type { AppDb } from "./client";
import { scanEvents } from "./schema";

export interface AuditEventInput {
  organizationId: string;
  actorUserId?: string | null;
  scanId?: string | null;
  type: string;
  metadata?: unknown;
}

export async function recordScanEvent(db: AppDb, input: AuditEventInput) {
  await db.insert(scanEvents).values({
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    actorUserId: input.actorUserId || null,
    scanId: input.scanId || null,
    type: input.type,
    metadataJson: input.metadata ?? null,
    createdAt: new Date(),
  });
}

const SENSITIVE_EVENT_METADATA_KEYS = new Set([
  "tokenCiphertext",
  "tokenFingerprint",
  "tokenLast4",
  "tokenNonce",
]);

export function redactScanEventForClient<T extends { metadataJson: unknown }>(event: T): T {
  return { ...event, metadataJson: redactScanEventMetadata(event.metadataJson) };
}

function redactScanEventMetadata(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_EVENT_METADATA_KEYS.has(key)) continue;
    redacted[key] = redactScanEventMetadata(item);
  }
  return redacted;
}
