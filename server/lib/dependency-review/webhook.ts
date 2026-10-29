import type { AppDb } from "../../db/client";
import {
  createDependencyReview,
  getDependencyReviewByCheckRun,
  getDependencyReviewForHead,
  getDependencyReviewSettings,
  type DependencyReviewRecord,
} from "../../db/dependency-reviews";
import { getInstallationByExternalId } from "../github-app/persistence";
import { isRecord } from "../platform/guards";
import { APPROVE_ACTION_IDENTIFIER, SKIP_EXTERNAL_ID_PREFIX } from "./render";

// GitHub's own record of who opened the PR, which a fork cannot claim.
const DEFAULT_DEPENDENCY_BOT_LOGINS: readonly string[] = ["dependabot[bot]", "renovate[bot]"];
const SHA = /^[0-9a-f]{40}$/;

export interface ParsedPullRequestEvent {
  kind: "pull_request";
  action: "opened" | "synchronize" | "reopened";
  installationId: string;
  repositoryId: number;
  repositoryFullName: string;
  pullNumber: number;
  headSha: string;
  authorLogin: string;
  authorType: string;
  // Who caused this delivery: on `synchronize`, the pusher, not the author.
  senderLogin: string;
  headRepositoryId: number | null;
}

export interface ParsedCheckRunEvent {
  kind: "check_run";
  action: "requested_action" | "rerequested";
  installationId: string;
  repositoryId: number;
  checkRunId: number;
  appId: string;
  headSha: string;
  identifier: string | null;
  externalId: string | null;
  senderLogin: string;
  senderId: number;
}

export type DependencyReviewParseError =
  | "unsupported_action"
  | "missing_installation"
  | "missing_repository"
  | "missing_pull_request"
  | "missing_check_run";

export function parsePullRequestEvent(
  body: Record<string, unknown>,
): ParsedPullRequestEvent | { error: DependencyReviewParseError } {
  const action = body.action;
  if (action !== "opened" && action !== "synchronize" && action !== "reopened") {
    return { error: "unsupported_action" };
  }
  const installationId = idString(isRecord(body.installation) ? body.installation.id : null);
  if (!installationId) return { error: "missing_installation" };
  const repository = isRecord(body.repository) ? body.repository : null;
  const repositoryId = idNumber(repository?.id);
  const repositoryFullName = typeof repository?.full_name === "string" ? repository.full_name : "";
  if (!repositoryId || !repositoryFullName) return { error: "missing_repository" };
  const pr = isRecord(body.pull_request) ? body.pull_request : null;
  const pullNumber = idNumber(pr?.number);
  const head = isRecord(pr?.head) ? pr.head : null;
  const headSha = typeof head?.sha === "string" ? head.sha : "";
  const user = isRecord(pr?.user) ? pr.user : null;
  const authorLogin = typeof user?.login === "string" ? user.login : "";
  if (!pullNumber || !SHA.test(headSha) || !authorLogin) return { error: "missing_pull_request" };
  const headRepo = isRecord(head?.repo) ? head.repo : null;
  return {
    kind: "pull_request",
    action,
    installationId,
    repositoryId,
    repositoryFullName,
    pullNumber,
    headSha,
    authorLogin,
    authorType: typeof user?.type === "string" ? user.type : "",
    senderLogin:
      isRecord(body.sender) && typeof body.sender.login === "string" ? body.sender.login : "",
    headRepositoryId: idNumber(headRepo?.id) || null,
  };
}

export function parseCheckRunEvent(
  body: Record<string, unknown>,
): ParsedCheckRunEvent | { error: DependencyReviewParseError } {
  const action = body.action;
  if (action !== "requested_action" && action !== "rerequested") {
    return { error: "unsupported_action" };
  }
  const installationId = idString(isRecord(body.installation) ? body.installation.id : null);
  if (!installationId) return { error: "missing_installation" };
  const repositoryId = idNumber(isRecord(body.repository) ? body.repository.id : null);
  if (!repositoryId) return { error: "missing_repository" };
  const run = isRecord(body.check_run) ? body.check_run : null;
  const checkRunId = idNumber(run?.id);
  const headSha = typeof run?.head_sha === "string" ? run.head_sha : "";
  const appId = idString(isRecord(run?.app) ? run.app.id : null);
  if (!checkRunId || !SHA.test(headSha) || !appId) return { error: "missing_check_run" };
  const requested = isRecord(body.requested_action) ? body.requested_action : null;
  const sender = isRecord(body.sender) ? body.sender : null;
  return {
    kind: "check_run",
    action,
    installationId,
    repositoryId,
    checkRunId,
    appId,
    headSha,
    identifier: typeof requested?.identifier === "string" ? requested.identifier : null,
    externalId: typeof run?.external_id === "string" && run.external_id ? run.external_id : null,
    senderLogin: typeof sender?.login === "string" ? sender.login : "",
    senderId: idNumber(sender?.id),
  };
}

export type DependencyReviewWebhookOutcome =
  | { kind: "dependency_review_queued"; review: DependencyReviewRecord; created: boolean }
  | {
      kind: "dependency_review_approval_requested";
      review: DependencyReviewRecord;
      checkRunId: number;
      senderLogin: string;
      senderId: number;
    }
  | { kind: "dependency_review_rerequested"; review: DependencyReviewRecord }
  | {
      kind: "dependency_review_skipped";
      organizationId: string;
      skip: {
        installationRowId: string;
        repositoryId: number;
        repositoryFullName: string;
        headSha: string;
        fromFork: boolean;
        authorLogin: string;
        senderLogin: string;
      };
    }
  | { kind: "ignored"; reason: string };

/**
 * Record a dependency-update PR's review. Only an installation mapped to an
 * organization that turned dependency review on, only PRs a dependency bot
 * opened, and only from a branch in the same repository: a fork's head is
 * someone else's commit, and the check would run against it. Anyone else's PR
 * gets a passing `skipped` check so a required check doesn't block it.
 */
export async function applyPullRequestEvent(
  db: AppDb,
  event: ParsedPullRequestEvent,
): Promise<DependencyReviewWebhookOutcome> {
  const installation = await getInstallationByExternalId(db, event.installationId);
  if (!installation || installation.status !== "active") {
    return { kind: "ignored", reason: "installation not active" };
  }
  const settings = await getDependencyReviewSettings(db, installation.organizationId);
  if (!settings.enabled) return { kind: "ignored", reason: "dependency review is off" };
  if (!isDependencyBot(event.authorLogin, event.authorType, settings.extraBotLogins)) {
    return {
      kind: "dependency_review_skipped",
      organizationId: installation.organizationId,
      skip: {
        installationRowId: installation.id,
        repositoryId: event.repositoryId,
        repositoryFullName: event.repositoryFullName,
        headSha: event.headSha,
        fromFork: event.headRepositoryId !== event.repositoryId,
        authorLogin: event.authorLogin,
        senderLogin: event.senderLogin,
      },
    };
  }
  if (event.headRepositoryId !== event.repositoryId) {
    return { kind: "ignored", reason: "head branch is in another repository" };
  }
  const { review, created } = await createDependencyReview(db, {
    organizationId: installation.organizationId,
    installationRowId: installation.id,
    repositoryId: event.repositoryId,
    repositoryFullName: event.repositoryFullName,
    pullNumber: event.pullNumber,
    headSha: event.headSha,
    authorLogin: event.authorLogin,
  });
  return { kind: "dependency_review_queued", review, created };
}

/**
 * The Approve and Re-run buttons on the check. GitHub sends these only to the
 * app that owns the run, but the app id is still compared, and the review is
 * looked up through the installation so one account can't reach another's.
 * Approval authority (repository write access) is checked by the job, which
 * has a token; the webhook only routes.
 */
export async function applyCheckRunEvent(
  db: AppDb,
  event: ParsedCheckRunEvent,
  appId: string,
): Promise<DependencyReviewWebhookOutcome> {
  if (event.appId !== appId) return { kind: "ignored", reason: "check run belongs to another app" };
  const installation = await getInstallationByExternalId(db, event.installationId);
  if (!installation || installation.status !== "active") {
    return { kind: "ignored", reason: "installation not active" };
  }
  // Re-run on a skip that a review replaced (it shows `cancelled`) re-runs that
  // review, the only way back for a PR whose newest run is the skip.
  const review = event.externalId?.startsWith(SKIP_EXTERNAL_ID_PREFIX)
    ? event.action === "rerequested"
      ? await getDependencyReviewForHead(db, installation.id, event.repositoryId, event.headSha)
      : null
    : await getDependencyReviewByCheckRun(
        db,
        installation.id,
        event.repositoryId,
        event.checkRunId,
        event.externalId,
      );
  if (!review || review.headSha !== event.headSha) {
    return { kind: "ignored", reason: "no dependency review for this check run" };
  }
  if (event.action === "rerequested") return { kind: "dependency_review_rerequested", review };
  if (event.identifier !== APPROVE_ACTION_IDENTIFIER) {
    return { kind: "ignored", reason: "unknown check run action" };
  }
  if (!event.senderLogin || !event.senderId) {
    return { kind: "ignored", reason: "check run action has no sender" };
  }
  return {
    kind: "dependency_review_approval_requested",
    review,
    checkRunId: event.checkRunId,
    senderLogin: event.senderLogin,
    senderId: event.senderId,
  };
}

export function isDependencyBot(
  login: string,
  type: string,
  extraLogins: readonly string[],
): boolean {
  const normalized = login.toLowerCase();
  if (DEFAULT_DEPENDENCY_BOT_LOGINS.includes(normalized)) return type === "Bot";
  // Self-hosted Renovate can run as a GitHub App bot or as a plain user
  // account, so an organization-listed login is accepted with either type.
  return extraLogins.some((extra) => extra.toLowerCase() === normalized);
}

function idString(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^\d{1,19}$/.test(value)) return value;
  return "";
}

function idNumber(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}
