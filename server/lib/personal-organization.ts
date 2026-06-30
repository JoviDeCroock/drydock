import type { AppDb, WorkspaceSession } from "../db";
import { ensurePersonalOrganizationWithCreation } from "../db";
import { describeOperationalError, emitOperationalEvent } from "./observability";
import { seedSampleScan } from "./sample-scan";

export async function resolvePersonalOrganization(
  db: AppDb,
  session: WorkspaceSession,
  env?: Cloudflare.Env,
): Promise<string> {
  const { organizationId, created } = await ensurePersonalOrganizationWithCreation(db, session);
  if (!created) return organizationId;

  try {
    await seedSampleScan(db, {
      organizationId,
      ownerUserId: session.userId,
      env,
    });
  } catch (err) {
    emitOperationalEvent("error", "sample_scan.seed_failed", {
      organizationId,
      error: describeOperationalError(err),
    });
  }

  return organizationId;
}
