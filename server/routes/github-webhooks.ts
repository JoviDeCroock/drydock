import { Hono } from "hono";
import { createDb } from "../db/client";
import { recordScanEvent } from "../db/events";
import { RateLimitError, enforceRateLimit } from "../db/rate-limit";
import {
  GithubAppConfigError,
  isGithubAppConfigured,
  readGithubAppConfig,
} from "../lib/github-app/config";
import {
  type WebhookOutcome,
  applyGithubWebhookEvent,
  parseGithubWebhookEvent,
  verifyGithubWebhookSignature,
} from "../lib/github-app/webhook";
import { recordProductEvent } from "../lib/platform/analytics";
import { emitOperationalEvent } from "../lib/platform/observability";
import type { Bindings, Variables } from "../types";

export const githubWebhookRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Bound how much body we'll read from a webhook delivery before failing closed.
// GitHub deliveries are well under 256KB; anything bigger is either misconfigured
// or hostile, so we don't want to spend Worker CPU on it.
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

githubWebhookRoutes.post("/github", async (c) => {
  if (!isGithubAppConfigured(c.env)) {
    emitOperationalEvent("warn", "github_webhook.config_missing", {});
    return c.json({ error: "github app not configured" }, 503);
  }

  let config;
  try {
    config = readGithubAppConfig(c.env);
  } catch (err) {
    if (err instanceof GithubAppConfigError) {
      emitOperationalEvent("error", "github_webhook.config_error", { message: err.message });
      return c.json({ error: "github app not configured" }, 503);
    }
    throw err;
  }

  const eventName = c.req.header("x-github-event")?.trim() ?? "";
  const deliveryId = c.req.header("x-github-delivery")?.trim() ?? "";
  const signature = c.req.header("x-hub-signature-256")?.trim() ?? null;

  if (!eventName || !deliveryId) {
    emitOperationalEvent("warn", "github_webhook.missing_headers", {
      hasEvent: Boolean(eventName),
      hasDelivery: Boolean(deliveryId),
    });
    return c.json({ error: "missing github webhook headers" }, 400);
  }

  const declaredBodyBytes = parseContentLength(c.req.header("content-length"));
  if (declaredBodyBytes === "invalid") {
    emitOperationalEvent("warn", "github_webhook.invalid_content_length", {
      deliveryId,
      eventName,
    });
    return c.json({ error: "invalid content-length" }, 400);
  }
  if (declaredBodyBytes !== null && declaredBodyBytes > MAX_WEBHOOK_BODY_BYTES) {
    emitOperationalEvent("warn", "github_webhook.body_too_large", {
      deliveryId,
      eventName,
      bytes: declaredBodyBytes,
    });
    return c.json({ error: "webhook body too large" }, 413);
  }

  const body = await readLimitedWebhookBody(c.req.raw, MAX_WEBHOOK_BODY_BYTES);
  if (body.tooLarge) {
    emitOperationalEvent("warn", "github_webhook.body_too_large", {
      deliveryId,
      eventName,
      bytes: body.bytes,
    });
    return c.json({ error: "webhook body too large" }, 413);
  }
  const buffer = body.buffer;
  if (buffer.byteLength === 0) {
    emitOperationalEvent("warn", "github_webhook.empty_body", { deliveryId, eventName });
    return c.json({ error: "empty webhook body" }, 400);
  }
  const rawBody = new TextDecoder().decode(buffer);

  const signatureValid = await verifyGithubWebhookSignature(
    config.webhookSecret,
    signature,
    rawBody,
  );
  if (!signatureValid) {
    emitOperationalEvent("warn", "github_webhook.signature_invalid", {
      deliveryId,
      eventName,
      hasSignature: Boolean(signature),
    });
    return c.json({ error: "invalid signature" }, 401);
  }

  const db = createDb(c.env.DB);
  try {
    await enforceRateLimit(db, {
      key: `github-webhook:${deliveryId.slice(0, 8)}`,
      limit: 60,
      windowMs: 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return c.json(
        { error: "webhook rate limit exceeded", retryAfterSeconds: err.retryAfterSeconds },
        429,
        { "retry-after": String(err.retryAfterSeconds) },
      );
    }
    throw err;
  }

  const parsed = parseGithubWebhookEvent(eventName, rawBody);
  if ("error" in parsed) {
    if (parsed.error === "unsupported_event" || parsed.error === "unsupported_action") {
      emitOperationalEvent("info", "github_webhook.ignored", {
        deliveryId,
        eventName,
        reason: parsed.error,
      });
      return c.json({ ok: true, ignored: parsed.error });
    }
    // Malformed deployment_protection_rule payloads are auditable failures —
    // we don't want to silently accept them.
    emitOperationalEvent("error", "github_webhook.invalid_payload", {
      deliveryId,
      eventName,
      reason: parsed.error,
    });
    return c.json({ error: `invalid webhook payload: ${parsed.error}` }, 400);
  }

  try {
    const outcome = await applyGithubWebhookEvent(db, parsed, { deliveryId });
    await recordOutcomeAudit(db, deliveryId, eventName, outcome);
    // Hand a pending gate to the queue consumer that runs the PyPI review and
    // posts the deployment decision. Guarded because the binding is optional in
    // tests/local; GitHub retries a non-2xx delivery and the consumer is
    // idempotent (it re-checks the gate status), so a re-enqueue is safe.
    if (outcome.kind === "gate_pending") {
      recordProductEvent(c.env, {
        name: "workflow_gate.opened",
        organizationId: outcome.gate.organizationId,
      });
    }
    if (outcome.kind === "gate_pending" && c.env.SCAN_QUEUE) {
      await c.env.SCAN_QUEUE.send({
        kind: "workflow_gate",
        organizationId: outcome.gate.organizationId,
        gateId: outcome.gate.id,
      });
    }
    return c.json({ ok: true, ...summarizeOutcome(outcome) });
  } catch (err) {
    emitOperationalEvent("error", "github_webhook.apply_failed", {
      deliveryId,
      eventName,
      message: err instanceof Error ? err.message : String(err),
    });
    // We failed closed: GitHub will retry, and the audit event above records
    // what we saw before the failure.
    return c.json({ error: "failed to apply webhook" }, 500);
  }
});

async function recordOutcomeAudit(
  db: ReturnType<typeof createDb>,
  deliveryId: string,
  eventName: string,
  outcome: WebhookOutcome,
): Promise<void> {
  if (outcome.kind === "gate_pending") {
    await recordScanEvent(db, {
      organizationId: outcome.gate.organizationId,
      type: "github_workflow_gate.requested",
      metadata: {
        deliveryId,
        eventName,
        gateId: outcome.gate.id,
        repositoryFullName: outcome.gate.repositoryFullName,
        environment: outcome.gate.environment,
        runId: outcome.gate.runId,
        created: outcome.created,
      },
    });
  }
}

function summarizeOutcome(outcome: WebhookOutcome) {
  if (outcome.kind === "gate_pending") {
    return {
      result: "gate_pending",
      gateId: outcome.gate.id,
      created: outcome.created,
    };
  }
  if (outcome.kind === "installation_updated") {
    return { result: "installation_updated", action: outcome.action };
  }
  return { result: "ignored", reason: outcome.reason };
}

function parseContentLength(value: string | null | undefined): number | "invalid" | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return "invalid";
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : "invalid";
}

async function readLimitedWebhookBody(
  request: Request,
  maxBytes: number,
): Promise<{ buffer: Uint8Array; bytes: number; tooLarge: boolean }> {
  if (!request.body) return { buffer: new Uint8Array(), bytes: 0, tooLarge: false };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { buffer: new Uint8Array(), bytes: total, tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { buffer, bytes: total, tooLarge: false };
}
