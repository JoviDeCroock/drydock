import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import type { AppDb } from "../../../server/db/client";
import type { CreateScanJobInput } from "../../../server/db/scan-jobs";
import { getScan } from "../../../server/db/scan-detail";
import { registrySupersessionPatch } from "../../../server/db/scan-status";
import { scans } from "../../../server/db/schema";

// Historical fixtures may lack registry evidence or contain competing organizations.
// Insert them directly: new staged admissions must pass package-claim verification.
function registryTimestampOrNull(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function sha1OrNull(value: string | null | undefined): string | null {
  const digest = value?.trim().toLowerCase();
  return digest && /^[0-9a-f]{40}$/.test(digest) ? digest : null;
}

export async function seedLegacyScanJob(db: AppDb, input: CreateScanJobInput) {
  const now = new Date();
  const source = input.source ?? "manual";
  const values = {
    id: input.id,
    stageId: input.stageId,
    organizationId: input.organizationId,
    ownerUserId: input.ownerUserId,
    gateId: input.gateId ?? null,
    packageName: input.packageName ?? null,
    stagedVersion: input.stagedVersion ?? null,
    stagedCreatedAt: registryTimestampOrNull(input.stagedCreatedAt),
    stagedDeclaredSha1: sha1OrNull(input.stagedDeclaredSha1),
    registryUrl: input.registryUrl ?? null,
    registryPackageName:
      source !== "workflow_gate" && input.registryUrl ? (input.packageName ?? null) : null,
    registryVersion:
      source !== "workflow_gate" && input.registryUrl ? (input.stagedVersion ?? null) : null,
    risk: "unknown",
    status: "pending" as const,
    source,
    createdAt: now,
    updatedAt: now,
  };
  const create = db.insert(scans).values(values);
  if (source !== "workflow_gate" && input.registryUrl && input.packageName && input.stagedVersion) {
    await db.batch([
      create,
      db
        .update(scans)
        .set(registrySupersessionPatch(now))
        .where(
          and(
            eq(scans.organizationId, input.organizationId),
            eq(scans.registryUrl, input.registryUrl),
            eq(scans.registryPackageName, input.packageName),
            eq(scans.registryVersion, input.stagedVersion),
            inArray(scans.source, ["manual", "auto_discovery"]),
            isNull(scans.registryStatusSupersededAt),
            ne(scans.id, input.id),
          ),
        ),
    ]);
  } else {
    await create;
  }
  return getScan(db, input.id, input.organizationId);
}
