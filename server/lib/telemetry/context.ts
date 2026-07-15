import { AsyncLocalStorage } from "node:async_hooks";

export interface TelemetryRuntimeContext {
  requestId?: string | null;
  journeyId?: string | null;
  organizationId?: string | null;
  serviceVersion?: string | null;
  environment?: string | null;
  analytics?: AnalyticsEngineDataset | null;
  analyticsHashKey?: string | null;
  executionCtx?: ExecutionContext | null;
}

const storage = new AsyncLocalStorage<TelemetryRuntimeContext>();
const OPAQUE_ID_RE = /^(?:req|jny)_[A-Za-z0-9_-]{8,128}$/;

export function newTelemetryId(prefix: "evt" | "req" | "ref" | "jny") {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function readJourneyId(value: string | null | undefined): string | null {
  if (!value || !OPAQUE_ID_RE.test(value)) return null;
  return value;
}

export function withTelemetryContext<T>(context: TelemetryRuntimeContext, callback: () => T): T {
  return storage.run(context, callback);
}

export function currentTelemetryContext(): TelemetryRuntimeContext {
  return storage.getStore() ?? {};
}
