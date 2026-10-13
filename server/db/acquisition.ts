import { and, eq, gt, isNull } from "drizzle-orm";
import type { AppDb } from "./client";
import { organizations, userAcquisition } from "./schema";
import { type Acquisition, recordAcquisitionMilestone } from "../lib/acquisition";
import { describeOperationalError, emitOperationalEvent } from "../lib/platform/observability";
import type { Bindings } from "../types";

export async function recordSignupAcquisition(
  db: AppDb,
  env: Pick<Bindings, "PRODUCT_ANALYTICS">,
  userId: string,
  acquisition: Acquisition,
): Promise<void> {
  try {
    const rows = await db
      .insert(userAcquisition)
      .values({
        userId,
        experiment: acquisition.experiment,
        variant: acquisition.variant,
        channel: acquisition.channel,
        expiresAt: new Date(acquisition.expiresDay * 86_400_000),
      })
      .onConflictDoNothing()
      .returning({ userId: userAcquisition.userId });
    if (rows.length) recordAcquisitionMilestone(env, acquisition, "signed_up");
  } catch (err) {
    emitOperationalEvent("warn", "acquisition.signup_unavailable", {
      error: describeOperationalError(err),
    });
  }
}

export async function recordFirstReviewAcquisition(
  db: AppDb,
  env: Pick<Bindings, "PRODUCT_ANALYTICS"> | undefined,
  organizationId: string,
): Promise<void> {
  if (!env?.PRODUCT_ANALYTICS) return;
  try {
    const [owner] = await db
      .select({ userId: organizations.ownerUserId })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    if (!owner) return;
    // Conditional UPDATE owns deduplication across queue retries and concurrent reviews.
    const [acquisition] = await db
      .update(userAcquisition)
      .set({ firstReviewAt: new Date() })
      .where(
        and(
          eq(userAcquisition.userId, owner.userId),
          isNull(userAcquisition.firstReviewAt),
          gt(userAcquisition.expiresAt, new Date()),
        ),
      )
      .returning();
    if (acquisition) recordAcquisitionMilestone(env, acquisition, "first_review");
  } catch (err) {
    emitOperationalEvent("warn", "acquisition.activation_unavailable", {
      error: describeOperationalError(err),
    });
  }
}
