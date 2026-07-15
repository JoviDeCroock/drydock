import type { OperationalTelemetryEvent } from "./events";

export async function writeAnalyticsEvent(
  dataset: AnalyticsEngineDataset,
  hashKey: string,
  telemetry: OperationalTelemetryEvent,
): Promise<void> {
  const organizationId = telemetry.tenant.organization_id;
  const tenantIndex = organizationId
    ? await sha256Base64Url(`${hashKey}:${organizationId}`)
    : "anonymous";
  const error = telemetry.outcome.error;

  dataset.writeDataPoint({
    // Ordered schema is a contract. Append columns; never reorder existing ones.
    blobs: [
      telemetry.event.name,
      telemetry.service.version,
      telemetry.service.environment,
      telemetry.severity,
      telemetry.product.surface,
      telemetry.product.ecosystem ?? "",
      telemetry.product.phase,
      telemetry.outcome.status,
      error?.code ?? "",
      error?.class ?? "",
      String(error?.retryable ?? false),
      String(error?.customer_visible ?? false),
    ],
    doubles: [
      telemetry.measurements.duration_ms ?? 0,
      telemetry.measurements.attempt ?? 0,
      telemetry.measurements.count ?? 1,
    ],
    indexes: [tenantIndex.slice(0, 96)],
  });
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
