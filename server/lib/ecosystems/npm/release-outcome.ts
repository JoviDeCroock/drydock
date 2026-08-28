import { type AppDb } from "../../../db/client";
import { getNpmConnection } from "../../../db/npm-connections";
import {
  getScanReleaseIdentity,
  listScansAwaitingRegistryStatus,
  markRegistryPublishReminderSent,
  recordRegistryVersionStatus,
  supersedeRegistryReleaseIncarnations,
  type RegistryStatusCandidate,
} from "../../../db/scans";
import { notifyStagedReleaseAwaitingApproval } from "../../notify";
import { allowInsecureLocalRegistry, decryptNpmToken } from "./connection";
import { mapWithConcurrency } from "../../platform/concurrency";
import { emitOperationalEvent } from "../../platform/observability";
import {
  fetchNpmVersionStatus,
  NPM_RELEASE_OUTCOME_FAILURE_CODES,
  type NpmVersionStatus,
} from "./version-status";

const LOOKUPS_PER_SWEEP = 16;
const LOOKUP_CONCURRENCY = 4;

const PENDING_RECHECK_MS = 5 * 60 * 1000;
const STAGED_RECHECK_MS = 60 * 60 * 1000;
const PUBLISHED_RECHECK_MS = 24 * 60 * 60 * 1000;

// After every review has received its first lookup, stop rechecking releases
// older than this floor.
const MAX_RELEASE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const FORGOTTEN_APPROVAL_DELAY_MS = 6 * 60 * 60 * 1000;

export interface ResolveReleaseOutcomesInput {
  db: AppDb;
  env: Cloudflare.Env;
  organizationId: string;
  ownerUserId: string;
  connection: { token: string; registryUrl: string };
  stagedItems?: readonly {
    id: string;
    packageName: string | null;
    version: string | null;
  }[];
  allowInsecureLocalhost?: boolean;
  now?: Date;
  lookupLimit?: number;
  lookupConcurrency?: number;
}

export interface ResolveReleaseOutcomesResult {
  checked: number;
  resolved: number;
  statuses: Partial<Record<NpmVersionStatus, number>>;
  reminded: number;
}

export async function resolveNpmReleaseOutcomes(
  input: ResolveReleaseOutcomesInput,
): Promise<ResolveReleaseOutcomesResult> {
  const { db, env, organizationId, ownerUserId, connection, allowInsecureLocalhost } = input;
  const now = input.now ?? new Date();
  const result: ResolveReleaseOutcomesResult = {
    checked: 0,
    resolved: 0,
    statuses: {},
    reminded: 0,
  };

  const currentStages = new Map<
    string,
    NonNullable<ResolveReleaseOutcomesInput["stagedItems"]>[number]
  >();
  for (const item of input.stagedItems ?? []) {
    if (!item.packageName || !item.version) continue;
    const key = releaseCoordinateKey(item.packageName, item.version);
    if (!currentStages.has(key)) currentStages.set(key, item);
  }
  if (currentStages.size) {
    await supersedeRegistryReleaseIncarnations(db, {
      organizationId,
      registryUrl: connection.registryUrl,
      releases: [...currentStages.values()].map((item) => ({
        stageId: item.id,
        packageName: item.packageName!,
        version: item.version!,
      })),
      supersededAt: now,
    });
  }

  const due = await listScansAwaitingRegistryStatus(db, organizationId, {
    limit: input.lookupLimit ?? LOOKUPS_PER_SWEEP,
    registryUrl: connection.registryUrl,
    createdAfter: new Date(now.getTime() - MAX_RELEASE_AGE_MS),
    rules: [
      { status: null, recheckBefore: new Date(now.getTime() - PENDING_RECHECK_MS) },
      { status: "validating", recheckBefore: new Date(now.getTime() - PENDING_RECHECK_MS) },
      { status: "staged", recheckBefore: new Date(now.getTime() - STAGED_RECHECK_MS) },
      { status: "published", recheckBefore: new Date(now.getTime() - PUBLISHED_RECHECK_MS) },
    ],
  });
  const eligible = due.filter((candidate) => {
    const currentStageId = currentStages.get(
      releaseCoordinateKey(candidate.packageName, candidate.stagedVersion),
    );
    return !currentStageId || currentStageId.id === candidate.stageId;
  });
  if (!eligible.length) return result;
  result.checked = eligible.length;

  await mapWithConcurrency(
    eligible,
    input.lookupConcurrency ?? LOOKUP_CONCURRENCY,
    async (candidate) => {
      try {
        const lookup = await fetchNpmVersionStatus(
          connection.registryUrl,
          connection.token,
          candidate.packageName,
          candidate.stagedVersion,
          { allowInsecureLocalhost },
        );
        const status = lookup.ok ? lookup.status : null;

        let persisted: boolean;
        try {
          persisted = await recordRegistryVersionStatus(db, {
            scanId: candidate.id,
            organizationId,
            status,
            checkedAt: now,
          });
        } catch (err) {
          emitOperationalEvent("warn", "npm.release_outcome.persist_failed", {
            organizationId,
            scanId: candidate.id,
            error: err instanceof Error ? err.name : "unknown",
          });
          return;
        }
        if (!persisted) return;

        if (!status) return;
        result.resolved += 1;
        result.statuses[status] = (result.statuses[status] ?? 0) + 1;

        if (!shouldRemindAboutForgottenApproval(candidate, status, now)) return;
        if (!candidate.decidedAt) return;
        // Claim before sending so overlapping sweeps cannot duplicate the reminder.
        const claimed = await markRegistryPublishReminderSent(db, {
          scanId: candidate.id,
          organizationId,
          expectedDecidedAt: candidate.decidedAt,
          expectedRegistryStatusAt: now,
          sentAt: now,
        });
        if (!claimed) return;
        result.reminded += 1;
        await notifyStagedReleaseAwaitingApproval({
          env,
          db,
          organizationId,
          ownerUserId,
          scanId: candidate.id,
          stageId: candidate.stageId,
          packageName: candidate.packageName,
          version: candidate.stagedVersion,
          decidedAt: candidate.decidedAt,
          registryUrl: connection.registryUrl,
        });
      } catch {}
    },
  );

  return result;
}

const RELEASE_OUTCOME_FAILURES: Partial<Record<NpmVersionStatus, StagedReleaseFailure>> = {
  published: {
    code: NPM_RELEASE_OUTCOME_FAILURE_CODES.published,
    message: "This version was approved and published to npm before the review could read it.",
  },
  deleted: {
    code: NPM_RELEASE_OUTCOME_FAILURE_CODES.deleted,
    message: "This version was published to npm and then removed before the review could read it.",
  },
  blocked: {
    code: NPM_RELEASE_OUTCOME_FAILURE_CODES.blocked,
    message: "npm blocked this version during its own validation, so its staged bytes are gone.",
  },
};

interface StagedReleaseFailure {
  code: string;
  message: string;
}

export interface StagedReleaseFate {
  status: NpmVersionStatus;
  failure: StagedReleaseFailure | null;
}

export async function lookupStagedReleaseFate(
  env: Cloudflare.Env,
  db: AppDb,
  scanId: string,
  organizationId: string,
): Promise<StagedReleaseFate | null> {
  try {
    const identity = await getScanReleaseIdentity(db, scanId, organizationId);
    if (
      !identity?.packageName ||
      !identity.stagedVersion ||
      !identity.registryUrl ||
      identity.registryStatusSupersededAt
    ) {
      return null;
    }
    const connection = await getNpmConnection(db, organizationId);
    if (!connection || connection.registryUrl !== identity.registryUrl) return null;
    const token = await decryptNpmToken(env, connection);
    const lookup = await fetchNpmVersionStatus(
      connection.registryUrl,
      token,
      identity.packageName,
      identity.stagedVersion,
      { allowInsecureLocalhost: allowInsecureLocalRegistry(env) },
    );
    if (!lookup.ok) return null;
    const currentIdentity = await getScanReleaseIdentity(db, scanId, organizationId);
    if (
      !currentIdentity ||
      currentIdentity.registryStatusSupersededAt ||
      currentIdentity.packageName !== identity.packageName ||
      currentIdentity.stagedVersion !== identity.stagedVersion ||
      currentIdentity.registryUrl !== identity.registryUrl
    ) {
      return null;
    }
    return { status: lookup.status, failure: RELEASE_OUTCOME_FAILURES[lookup.status] ?? null };
  } catch {
    return null;
  }
}

function releaseCoordinateKey(packageName: string, version: string): string {
  return JSON.stringify([packageName, version]);
}

export function shouldRemindAboutForgottenApproval(
  candidate: Pick<RegistryStatusCandidate, "decision" | "decidedAt" | "registryPublishReminderAt">,
  status: NpmVersionStatus,
  now: Date,
): boolean {
  if (status !== "staged") return false;
  if (candidate.decision !== "publish") return false;
  if (candidate.registryPublishReminderAt) return false;
  const decidedAt = candidate.decidedAt ? new Date(candidate.decidedAt).getTime() : null;
  if (decidedAt === null || Number.isNaN(decidedAt)) return false;
  return now.getTime() - decidedAt >= FORGOTTEN_APPROVAL_DELAY_MS;
}
