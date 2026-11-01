import { type AppDb } from "../../db/client";
import { recordScanEvent } from "../../db/events";
import { getOrganizationName, getOrganizationOwnerUserId } from "../../db/organizations";
import type { RiskLevel } from "../review";
import { deliverOrganizationNotification } from "./deliver";
import { formatPackageLabel } from "./format";
import { scanUrl } from "./links";

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
 * Tell the organization's notification recipients that a workflow gate has a
 * completed review parked pending a decision. Drydock never auto-decides a gate,
 * so this is the only proactive signal that a held GitHub deployment is waiting
 * on a human.
 *
 * Send-once is owned by the caller: `executeWorkflowGateJob` only reaches the
 * review-ready path once per gate (a re-delivered gate with a completed scan
 * short-circuits at its `already_reviewed` guard), so a single review-ready
 * transition produces a single email per recipient. The body carries only
 * release identity, risk, repo/environment, and a dashboard link; no token,
 * header, or artifact bytes ever reach the email.
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
  const organizationName = await getOrganizationName(db, organizationId);

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

  await deliverOrganizationNotification(env, db, {
    organizationId,
    ownerUserId,
    scanId,
    eventPrefix: "github_workflow_gate",
    eventMetadata: { gateId, releaseRisk },
    email: {
      subject: `Release gate needs your review — ${packageLabel}`,
      lines: [
        "Hi there,",
        "",
        `A staged release is held in ${repositoryFullName} and is waiting for a decision before it can publish.`,
        "",
        organizationName ? `Organization: ${organizationName}` : null,
        `Package: ${packageDisplay}`,
        `Release risk: ${releaseRisk}`,
        `Repository: ${repositoryFullName}`,
        `Environment: ${environment}`,
        "",
        dashboardUrl ? `Approve or reject the held job: ${dashboardUrl}` : null,
        "",
        "The held GitHub deployment stays blocked until someone approves or rejects it.",
        "",
        "— Drydock",
      ],
    },
    slack: {
      title: "Release gate needs a decision",
      packageLabel: packageDisplay,
      source: "GitHub workflow gate",
      risk: releaseRisk,
      repository: repositoryFullName,
      environment,
      statusLine: `Held in ${repositoryFullName} — the deployment stays blocked until someone approves or rejects it.`,
      dashboardUrl,
    },
  });
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
 * review.
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
  const organizationName = await getOrganizationName(db, organizationId);

  const packageLabel = formatPackageLabel(packageName, version);
  const dashboardUrl = scanUrl(env, scanId, organizationId);

  await deliverOrganizationNotification(env, db, {
    organizationId,
    ownerUserId,
    scanId,
    eventPrefix: "github_workflow_gate",
    eventMetadata: { gateId, trigger: "timeout_missed" },
    email: {
      subject: `GitHub gate for ${packageLabel} timed out before scan completed`,
      lines: [
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
      ],
    },
    slack: null,
  });
}

export interface NotifyHeldReleasePublishFailedInput {
  env: Cloudflare.Env;
  db: AppDb;
  organizationId: string;
  gateId: string;
  repositoryFullName: string;
  environment: string;
  scanId: string | null;
  /** Maintainer-safe summary (project names and states only, never URLs). */
  detail: string;
}

/**
 * A held release did not publish after GitHub already accepted the approval:
 * the deployment job runs on, but the release is not on the index. Nothing in
 * GitHub shows this, so record it and tell the maintainers directly.
 */
export async function notifyHeldReleasePublishFailed(
  input: NotifyHeldReleasePublishFailedInput,
): Promise<void> {
  const { env, db, organizationId, gateId, repositoryFullName, environment, scanId, detail } =
    input;
  await recordScanEvent(db, {
    organizationId,
    scanId,
    type: "github_workflow_gate.held_release_publish_failed",
    metadata: { gateId, detail },
  });
  const ownerUserId = await getOrganizationOwnerUserId(db, organizationId);
  if (!ownerUserId) return;
  const organizationName = await getOrganizationName(db, organizationId);
  const dashboardUrl = scanId ? scanUrl(env, scanId, organizationId) : null;
  await deliverOrganizationNotification(env, db, {
    organizationId,
    ownerUserId,
    ...(scanId ? { scanId } : {}),
    eventPrefix: "github_workflow_gate",
    eventMetadata: { gateId, trigger: "held_release_publish_failed" },
    email: {
      subject: `Approved release in ${repositoryFullName} was not published`,
      lines: [
        "Hi there,",
        "",
        `GitHub accepted the approval for ${repositoryFullName} (${environment}), but Drydock could not publish the held release: ${detail}.`,
        "The deployment job continues on GitHub; the release is not on the index.",
        "",
        organizationName ? `Organization: ${organizationName}` : null,
        `Repository: ${repositoryFullName}`,
        `Environment: ${environment}`,
        "",
        dashboardUrl ? `See the gate: ${dashboardUrl}` : null,
        "",
        "Re-run the workflow to stage and review the release again.",
        "",
        "— Drydock",
      ],
    },
    slack: null,
  });
}
