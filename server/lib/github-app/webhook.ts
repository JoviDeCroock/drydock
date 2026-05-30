import { hexDecode, hmacSha256, timingSafeEqual } from "../crypto-utils";
import type { AppDb } from "../../db";
import { getInstallationAccessToken } from "./api";
import type { GithubAppConfig } from "./config";
import { markInstallationStatus, resolveDeploymentProtectionTarget } from "./persistence";
import { recordGateRequest, type WorkflowGateRecord } from "./webhook-gates";

// ── Signature verification ───────────────────────────────────────────────────

const SIGNATURE_PREFIX = "sha256=";

/**
 * Constant-time verification of GitHub's HMAC-SHA256 webhook signature. GitHub
 * sends the signature as `sha256=<hex>` in the `X-Hub-Signature-256` header and
 * computes it over the raw request body. We must compare the bytes — not the
 * string — to avoid timing leaks, and we MUST reject any request that does not
 * carry a valid signature header. Anything else would let an attacker bypass
 * the gate by replaying a forged payload.
 */
export async function verifyGithubWebhookSignature(
  secret: string,
  signatureHeader: string | null,
  rawBody: string,
): Promise<boolean> {
  if (!signatureHeader || !signatureHeader.startsWith(SIGNATURE_PREFIX)) return false;
  const provided = hexDecode(signatureHeader.slice(SIGNATURE_PREFIX.length));
  if (!provided) return false;
  const expected = await hmacSha256(secret, rawBody);
  return timingSafeEqual(expected, provided);
}

// ── Event parsing ────────────────────────────────────────────────────────────

export type WebhookParseError =
  | "invalid_json"
  | "unsupported_event"
  | "unsupported_action"
  | "missing_installation"
  | "missing_repository"
  | "missing_environment"
  | "missing_run"
  | "missing_callback_url"
  | "invalid_callback_url";

export interface ParsedDeploymentProtectionEvent {
  kind: "deployment_protection_rule";
  action: "requested";
  installationId: string;
  repositoryId: number;
  repositoryFullName: string;
  environment: string;
  runId: number;
  deploymentId: number | null;
  deploymentCallbackUrl: string;
}

export interface ParsedInstallationLifecycleEvent {
  kind: "installation";
  action: "suspend" | "unsuspend" | "deleted";
  installationId: string;
}

export type ParsedGithubEvent = ParsedDeploymentProtectionEvent | ParsedInstallationLifecycleEvent;

/**
 * Parse a raw webhook body for the events we care about. Returns a discriminated
 * union the caller can switch on, or a parse-error string the caller can audit.
 * Unknown event types fall through as `unsupported_event` so the route can ack
 * (HTTP 200) without doing anything, which is what GitHub expects.
 */
export function parseGithubWebhookEvent(
  eventName: string,
  rawBody: string,
): ParsedGithubEvent | { error: WebhookParseError } {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { error: "invalid_json" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { error: "invalid_json" };
  }

  if (eventName === "deployment_protection_rule") {
    return parseDeploymentProtectionEvent(payload as Record<string, unknown>);
  }
  if (eventName === "installation") {
    return parseInstallationLifecycleEvent(payload as Record<string, unknown>);
  }
  return { error: "unsupported_event" };
}

function parseDeploymentProtectionEvent(
  body: Record<string, unknown>,
): ParsedDeploymentProtectionEvent | { error: WebhookParseError } {
  const action = typeof body.action === "string" ? body.action : "";
  if (action !== "requested") return { error: "unsupported_action" };

  const installation = isObject(body.installation) ? body.installation : null;
  const installationId = extractIdAsString(installation?.id);
  if (!installationId) return { error: "missing_installation" };

  const repository = isObject(body.repository) ? body.repository : null;
  const repositoryId = extractIdAsNumber(repository?.id);
  const repositoryFullName = typeof repository?.full_name === "string" ? repository.full_name : "";
  if (!repositoryId || !repositoryFullName) return { error: "missing_repository" };

  const environment = typeof body.environment === "string" ? body.environment.trim() : "";
  if (!environment) return { error: "missing_environment" };

  const callbackUrl =
    typeof body.deployment_callback_url === "string" ? body.deployment_callback_url.trim() : "";
  if (!callbackUrl) return { error: "missing_callback_url" };
  if (!isAllowedCallbackUrl(callbackUrl)) return { error: "invalid_callback_url" };

  const runId = extractRunIdFromCallback(callbackUrl);
  if (!runId) return { error: "missing_run" };

  const deployment = isObject(body.deployment) ? body.deployment : null;
  const deploymentId = extractIdAsNumber(deployment?.id);

  return {
    kind: "deployment_protection_rule",
    action,
    installationId,
    repositoryId,
    repositoryFullName,
    environment,
    runId,
    deploymentId,
    deploymentCallbackUrl: callbackUrl,
  };
}

function parseInstallationLifecycleEvent(
  body: Record<string, unknown>,
): ParsedInstallationLifecycleEvent | { error: WebhookParseError } {
  const action = typeof body.action === "string" ? body.action : "";
  if (action !== "suspend" && action !== "unsuspend" && action !== "deleted") {
    return { error: "unsupported_action" };
  }
  const installation = isObject(body.installation) ? body.installation : null;
  const installationId = extractIdAsString(installation?.id);
  if (!installationId) return { error: "missing_installation" };
  return { kind: "installation", action, installationId };
}

// Only allow callback URLs that look like the real GitHub Actions deployment
// protection callback path; otherwise a spoofed payload could trick us into
// posting an approval to an attacker-controlled host.
const CALLBACK_PATH_RE =
  /^\/repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/deployment_protection_rule\/?$/;

function isAllowedCallbackUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.host !== "api.github.com") return false;
  return CALLBACK_PATH_RE.test(parsed.pathname);
}

function extractRunIdFromCallback(url: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const match = parsed.pathname.match(CALLBACK_PATH_RE);
  if (!match) return null;
  const numeric = Number.parseInt(match[1], 10);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function extractIdAsString(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value) && Math.floor(value) === value) {
    return String(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  return "";
}

function extractIdAsNumber(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  }
  return 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

// ── Webhook dispatcher ───────────────────────────────────────────────────────

export type WebhookOutcome =
  | { kind: "gate_pending"; gate: WorkflowGateRecord; created: boolean }
  | { kind: "installation_updated"; installationId: string; action: string }
  | { kind: "ignored"; reason: string };

export interface DispatchDeps {
  deliveryId: string;
}

/**
 * Apply a verified webhook event to the database. Lookup misses (unknown
 * installation / unmapped environment) intentionally return `ignored` rather
 * than 4xx so GitHub considers the delivery successful — replaying a 404 over
 * and over for an unmapped environment would clutter the audit log without
 * any safety win. Malformed payloads, by contrast, are surfaced by the caller
 * with HTTP 400 because they are a signal of either misconfiguration or
 * tampering.
 */
export async function applyGithubWebhookEvent(
  db: AppDb,
  event: ParsedGithubEvent,
  deps: DispatchDeps,
): Promise<WebhookOutcome> {
  if (event.kind === "deployment_protection_rule") {
    const resolved = await resolveDeploymentProtectionTarget(db, {
      installationId: event.installationId,
      repositoryId: event.repositoryId,
      environment: event.environment,
    });
    if (!resolved) {
      return {
        kind: "ignored",
        reason: "no release target mapped for this installation/repository/environment",
      };
    }
    const { gate, created } = await recordGateRequest(db, {
      deliveryId: deps.deliveryId,
      installation: resolved.installation,
      releaseTarget: resolved.releaseTarget,
      event,
    });
    return { kind: "gate_pending", gate, created };
  }

  if (event.kind === "installation") {
    const status =
      event.action === "suspend"
        ? "suspended"
        : event.action === "unsuspend"
          ? "active"
          : "uninstalled";
    await markInstallationStatus(db, event.installationId, status);
    return {
      kind: "installation_updated",
      installationId: event.installationId,
      action: event.action,
    };
  }

  return { kind: "ignored", reason: "unhandled event kind" };
}

// ── Deployment protection callback ───────────────────────────────────────────

export interface DeploymentProtectionDecisionInput {
  config: GithubAppConfig;
  installationExternalId: string;
  callbackUrl: string;
  environment: string;
  state: "approved" | "rejected";
  comment: string;
}

/**
 * POST the deployment-protection decision callback to GitHub using a fresh
 * installation access token. The comment is what GitHub renders in the
 * Actions run log, so we lean on it to link back to the Drydock report.
 */
export async function postDeploymentProtectionDecision(
  input: DeploymentProtectionDecisionInput,
): Promise<void> {
  if (!isAllowedCallbackUrl(input.callbackUrl)) {
    throw new Error("refusing to POST decision to a non-GitHub callback URL");
  }
  const token = await getInstallationAccessToken(input.config, input.installationExternalId);
  const comment = input.comment.slice(0, 140);
  const response = await fetch(input.callbackUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "drydock-app",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      state: input.state,
      environment_name: input.environment,
      comment,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `GitHub deployment protection decision failed (${response.status}): ${text.slice(0, 200)}`,
    );
  }
}
