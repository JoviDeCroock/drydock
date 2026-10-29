import { and, asc, eq, gt, lte, ne } from "drizzle-orm";
import type { AppDb } from "./client";
import { publisherSetupJobs } from "./schema";
import { organizationArtifactPrefix } from "../lib/scan/artifacts/keys";
import type {
  PublisherSetupDraftRequest,
  PublisherSetupJobStage,
  PublisherSetupJobStatus,
} from "../lib/github-app/setup-types";

export type PublisherSetupJobRow = typeof publisherSetupJobs.$inferSelect;
const JOB_TTL_MS = 24 * 60 * 60_000;
const PAYLOAD_NAMES = [
  "source",
  "candidate",
  "judge",
  "result",
  "draft-agent",
  "judge-agent",
] as const;
export type PublisherSetupPayloadName = (typeof PAYLOAD_NAMES)[number];

export function publisherSetupPayloadKey(
  job: Pick<PublisherSetupJobRow, "organizationId" | "id">,
  name: PublisherSetupPayloadName,
): string {
  return `${organizationArtifactPrefix(job.organizationId)}publisher-setup/${encodeURIComponent(job.id)}/${name}.json`;
}

export async function createPublisherSetupJob(
  db: AppDb,
  organizationId: string,
  createdByUserId: string,
  request: PublisherSetupDraftRequest,
): Promise<PublisherSetupJobRow> {
  const now = new Date();
  const row: PublisherSetupJobRow = {
    id: crypto.randomUUID(),
    organizationId,
    createdByUserId,
    installationRowId: request.installationRowId,
    requestJson: request,
    status: "queued",
    stage: "queued",
    failureJson: null,
    expiresAt: new Date(now.getTime() + JOB_TTL_MS),
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(publisherSetupJobs).values(row);
  return row;
}

export async function getPublisherSetupJob(
  db: AppDb,
  id: string,
): Promise<PublisherSetupJobRow | null> {
  const [row] = await db
    .select()
    .from(publisherSetupJobs)
    .where(and(eq(publisherSetupJobs.id, id), gt(publisherSetupJobs.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

export async function getOwnedPublisherSetupJob(
  db: AppDb,
  id: string,
  organizationId: string,
  userId: string,
): Promise<PublisherSetupJobRow | null> {
  const [row] = await db
    .select()
    .from(publisherSetupJobs)
    .where(
      and(
        eq(publisherSetupJobs.id, id),
        eq(publisherSetupJobs.organizationId, organizationId),
        eq(publisherSetupJobs.createdByUserId, userId),
        gt(publisherSetupJobs.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function updatePublisherSetupJob(
  db: AppDb,
  id: string,
  update: {
    status?: PublisherSetupJobStatus;
    stage?: PublisherSetupJobStage;
    failureJson?: PublisherSetupJobRow["failureJson"];
  },
): Promise<boolean> {
  const updated = await db
    .update(publisherSetupJobs)
    .set({ ...update, updatedAt: new Date() })
    .where(
      and(
        eq(publisherSetupJobs.id, id),
        gt(publisherSetupJobs.expiresAt, new Date()),
        ne(publisherSetupJobs.status, "failed"),
        ne(publisherSetupJobs.status, "ready"),
      ),
    )
    .returning({ id: publisherSetupJobs.id });
  return updated.length > 0;
}

/** Cancels only before PR creation starts, so a cancelled job can never open a PR. */
export async function cancelPublisherSetupJob(db: AppDb, id: string): Promise<boolean> {
  const updated = await db
    .update(publisherSetupJobs)
    .set({
      status: "failed",
      failureJson: {
        code: "setup_cancelled",
        message: "Pull request preparation was cancelled.",
      },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(publisherSetupJobs.id, id),
        gt(publisherSetupJobs.expiresAt, new Date()),
        ne(publisherSetupJobs.status, "failed"),
        ne(publisherSetupJobs.status, "ready"),
        ne(publisherSetupJobs.stage, "create_pr"),
      ),
    )
    .returning({ id: publisherSetupJobs.id });
  return updated.length > 0;
}

export async function deletePublisherSetupJobPayloads(
  bucket: R2Bucket,
  job: Pick<PublisherSetupJobRow, "id" | "organizationId">,
): Promise<void> {
  await bucket.delete(PAYLOAD_NAMES.map((name) => publisherSetupPayloadKey(job, name)));
}

export async function prunePublisherSetupJobs(
  db: AppDb,
  bucket: R2Bucket,
  cutoff = new Date(),
): Promise<number> {
  const rows = await db
    .select()
    .from(publisherSetupJobs)
    .where(lte(publisherSetupJobs.expiresAt, cutoff))
    .orderBy(asc(publisherSetupJobs.expiresAt))
    .limit(100);
  for (const row of rows) {
    await deletePublisherSetupJobPayloads(bucket, row);
    await db.delete(publisherSetupJobs).where(eq(publisherSetupJobs.id, row.id));
  }
  return rows.length;
}

export async function deletePublisherSetupJobsForUser(
  db: AppDb,
  bucket: R2Bucket | undefined,
  userId: string,
): Promise<void> {
  const rows = await db
    .select()
    .from(publisherSetupJobs)
    .where(eq(publisherSetupJobs.createdByUserId, userId));
  for (const row of rows) {
    await db
      .update(publisherSetupJobs)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(publisherSetupJobs.id, row.id));
    if (bucket) await deletePublisherSetupJobPayloads(bucket, row);
    await db.delete(publisherSetupJobs).where(eq(publisherSetupJobs.id, row.id));
  }
}
