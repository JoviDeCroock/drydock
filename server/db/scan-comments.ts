import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { AppDb } from "./client";
import {
  organizationMembers,
  scanCommentMentions,
  scanComments,
  user,
  userNotificationSettings,
} from "./schema";

export interface ScanCommentRecord {
  id: string;
  scanId: string;
  organizationId: string;
  authorUserId: string | null;
  parentId: string | null;
  body: string;
  anchorType: string;
  filePath: string | null;
  line: number | null;
  fileSha256: string | null;
  findingId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface ScanCommentEntry extends ScanCommentRecord {
  authorName: string | null;
  authorEmail: string | null;
  mentionedUserIds: string[];
}

export interface CreateScanCommentInput {
  scanId: string;
  organizationId: string;
  authorUserId: string;
  parentId?: string | null;
  body: string;
  anchorType: string;
  filePath?: string | null;
  line?: number | null;
  fileSha256?: string | null;
  findingId?: string | null;
}

export async function createScanComment(
  db: AppDb,
  input: CreateScanCommentInput,
): Promise<ScanCommentRecord> {
  const now = new Date();
  const [row] = await db
    .insert(scanComments)
    .values({
      id: crypto.randomUUID(),
      scanId: input.scanId,
      organizationId: input.organizationId,
      authorUserId: input.authorUserId,
      parentId: input.parentId ?? null,
      body: input.body,
      anchorType: input.anchorType,
      filePath: input.filePath ?? null,
      line: input.line ?? null,
      fileSha256: input.fileSha256 ?? null,
      findingId: input.findingId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row;
}

export async function getScanComment(
  db: AppDb,
  commentId: string,
  scanId: string,
  organizationId: string,
): Promise<ScanCommentRecord | null> {
  const [row] = await db
    .select()
    .from(scanComments)
    .where(
      and(
        eq(scanComments.id, commentId),
        eq(scanComments.scanId, scanId),
        eq(scanComments.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listScanComments(
  db: AppDb,
  scanId: string,
  organizationId: string,
): Promise<ScanCommentEntry[]> {
  const rows = await db
    .select({
      comment: scanComments,
      authorName: user.name,
      authorEmail: user.email,
    })
    .from(scanComments)
    .leftJoin(user, eq(user.id, scanComments.authorUserId))
    .where(and(eq(scanComments.scanId, scanId), eq(scanComments.organizationId, organizationId)))
    .orderBy(asc(scanComments.createdAt));

  const commentIds = rows.map((row) => row.comment.id);
  const mentionRows = commentIds.length
    ? await db
        .select({
          commentId: scanCommentMentions.commentId,
          mentionedUserId: scanCommentMentions.mentionedUserId,
        })
        .from(scanCommentMentions)
        .where(inArray(scanCommentMentions.commentId, commentIds))
    : [];
  const mentionsByComment = new Map<string, string[]>();
  for (const row of mentionRows) {
    const bucket = mentionsByComment.get(row.commentId);
    if (bucket) bucket.push(row.mentionedUserId);
    else mentionsByComment.set(row.commentId, [row.mentionedUserId]);
  }

  return rows.map((row) => ({
    ...row.comment,
    authorName: row.authorName,
    authorEmail: row.authorEmail,
    mentionedUserIds: mentionsByComment.get(row.comment.id) ?? [],
  }));
}

export async function updateScanCommentBody(
  db: AppDb,
  commentId: string,
  body: string,
): Promise<ScanCommentRecord | null> {
  const [row] = await db
    .update(scanComments)
    .set({ body, updatedAt: new Date() })
    .where(and(eq(scanComments.id, commentId), isNull(scanComments.deletedAt)))
    .returning();
  return row ?? null;
}

export async function softDeleteScanComment(db: AppDb, commentId: string): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(scanComments)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(scanComments.id, commentId), isNull(scanComments.deletedAt)))
    .returning({ id: scanComments.id });
  return rows.length > 0;
}

/**
 * Restrict candidate mention targets to current members of the organization.
 * Anything else (ex-members, users from other orgs, fabricated ids) is silently
 * dropped so a comment body can never be used to probe which user ids exist.
 */
export async function filterOrganizationMemberIds(
  db: AppDb,
  organizationId: string,
  userIds: readonly string[],
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const rows = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        inArray(organizationMembers.userId, [...userIds]),
      ),
    );
  return rows.map((row) => row.userId);
}

/**
 * Record mention rows for a comment and return only the user ids that were
 * newly added — an edit that keeps an existing mention must not re-notify it.
 */
export async function addCommentMentions(
  db: AppDb,
  commentId: string,
  userIds: readonly string[],
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const existing = await db
    .select({ mentionedUserId: scanCommentMentions.mentionedUserId })
    .from(scanCommentMentions)
    .where(eq(scanCommentMentions.commentId, commentId));
  const known = new Set(existing.map((row) => row.mentionedUserId));
  const added = userIds.filter((userId) => !known.has(userId));
  if (added.length === 0) return [];
  const now = new Date();
  await db.insert(scanCommentMentions).values(
    added.map((mentionedUserId) => ({
      id: crypto.randomUUID(),
      commentId,
      mentionedUserId,
      createdAt: now,
    })),
  );
  return added;
}

export async function markMentionNotified(
  db: AppDb,
  commentId: string,
  mentionedUserId: string,
): Promise<void> {
  await db
    .update(scanCommentMentions)
    .set({ notifiedAt: new Date() })
    .where(
      and(
        eq(scanCommentMentions.commentId, commentId),
        eq(scanCommentMentions.mentionedUserId, mentionedUserId),
      ),
    );
}

export interface UserNotificationSettings {
  mentionEmails: boolean;
}

export async function getUserNotificationSettings(
  db: AppDb,
  userId: string,
): Promise<UserNotificationSettings> {
  const [row] = await db
    .select({ mentionEmails: userNotificationSettings.mentionEmails })
    .from(userNotificationSettings)
    .where(eq(userNotificationSettings.userId, userId))
    .limit(1);
  // No row means the user never touched the setting: defaults apply.
  return { mentionEmails: row?.mentionEmails ?? true };
}

export async function setUserNotificationSettings(
  db: AppDb,
  userId: string,
  settings: UserNotificationSettings,
): Promise<UserNotificationSettings> {
  const now = new Date();
  await db
    .insert(userNotificationSettings)
    .values({
      userId,
      mentionEmails: settings.mentionEmails,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: userNotificationSettings.userId,
      set: { mentionEmails: settings.mentionEmails, updatedAt: now },
    });
  return settings;
}
