import { and, desc, gte, lt, sql } from "drizzle-orm";
import type { AppDb } from "./client";
import { marketingReferrals } from "./schema";
import {
  referralDay,
  type MarketingSurface,
  type TrafficSource,
} from "../lib/platform/traffic-source";

// Counters are kept for two release cycles' worth of campaign history. Long
// enough to compare a channel across months, short enough that the table stays
// a rounding error next to scans.
export const MARKETING_REFERRAL_RETENTION_DAYS = 400;

export interface RecordReferralInput {
  surface: MarketingSurface;
  source: TrafficSource;
  nowMs?: number;
}

export async function recordMarketingReferral(db: AppDb, input: RecordReferralInput) {
  const nowMs = input.nowMs ?? Date.now();
  await db
    .insert(marketingReferrals)
    .values({
      day: referralDay(nowMs),
      surface: input.surface,
      source: input.source,
      views: 1,
      updatedAt: new Date(nowMs),
    })
    .onConflictDoUpdate({
      target: [marketingReferrals.day, marketingReferrals.surface, marketingReferrals.source],
      set: {
        views: sql`${marketingReferrals.views} + 1`,
        updatedAt: new Date(nowMs),
      },
    });
}

export interface MarketingReferralRow {
  day: string;
  surface: string;
  source: string;
  views: number;
}

export async function listMarketingReferrals(
  db: AppDb,
  options: { sinceDay: string; untilDay?: string } = { sinceDay: "0000-00-00" },
): Promise<MarketingReferralRow[]> {
  const filters = [gte(marketingReferrals.day, options.sinceDay)];
  if (options.untilDay) filters.push(lt(marketingReferrals.day, options.untilDay));
  const rows = await db
    .select({
      day: marketingReferrals.day,
      surface: marketingReferrals.surface,
      source: marketingReferrals.source,
      views: marketingReferrals.views,
    })
    .from(marketingReferrals)
    .where(and(...filters))
    .orderBy(desc(marketingReferrals.day));
  return rows;
}

export async function pruneMarketingReferralsOlderThan(db: AppDb, cutoffDay: string) {
  await db.delete(marketingReferrals).where(lt(marketingReferrals.day, cutoffDay));
}
