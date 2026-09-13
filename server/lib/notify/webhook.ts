import { hexEncode, hmacSha256 } from "../platform/crypto-utils";
import { isPublicHostname } from "../platform/public-hostname";

export interface WebhookEvent {
  version: 1;
  id: string;
  type: "scan.completed" | "scan.failed" | "workflow_gate.review_ready" | "notification.test";
  createdAt: string;
  organizationId: string;
  data: Record<string, unknown>;
}

export function validateWebhookUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      value.includes("#") ||
      (url.port && url.port !== "443") ||
      !isPublicHostname(url.hostname)
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

export async function sendWebhookNotification(input: {
  url: string;
  secret: string;
  event: WebhookEvent;
}): Promise<void> {
  const url = validateWebhookUrl(input.url);
  if (!url) throw new Error("Webhook endpoint is invalid");
  const body = JSON.stringify(input.event);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = hexEncode(await hmacSha256(input.secret, `${timestamp}.${body}`));
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: {
        "Content-Type": "application/json",
        "X-Drydock-Timestamp": timestamp,
        "X-Drydock-Signature": `v1=${signature}`,
      },
      body,
    });
  } catch {
    // Fetch errors can contain the endpoint's secret-bearing path or query.
    throw new Error("Webhook delivery failed");
  }
  // Never read or retain endpoint-controlled response content.
  void response.body?.cancel().catch(() => undefined);
  if (!response.ok) throw new Error("Webhook endpoint returned an unsuccessful response");
}
