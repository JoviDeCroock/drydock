import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import {
  RateLimitError,
  addCommentMentions,
  createDb,
  createScanComment,
  enforceRateLimit,
  filterOrganizationMemberIds,
  getScanComment,
  getUserContact,
  listScanComments,
  recordScanEvent,
  softDeleteScanComment,
  updateScanCommentBody,
  type AppDb,
  type ScanCommentEntry,
  type ScanCommentRecord,
} from "../db";
import { scanFiles, scanFindings, scans } from "../db/schema";
import { requireActiveOrganizationContext } from "../lib/active-organization";
import {
  COMMENT_BODY_MAX,
  extractMentionUserIds,
  isCommentAnchorType,
  type CommentAnchorType,
} from "../lib/comment-mentions";
import { rateLimitResponse } from "../lib/http";
import { notifyCommentMention } from "../lib/notify";
import { roleCanManageMembers } from "../lib/roles";
import type { Bindings, Variables } from "../types";

export const scanCommentsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

export interface PublicScanComment {
  id: string;
  scanId: string;
  parentId: string | null;
  authorUserId: string | null;
  authorName: string | null;
  body: string;
  anchorType: string;
  filePath: string | null;
  line: number | null;
  findingId: string | null;
  mentionedUserIds: string[];
  deleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// Deleted comments keep their place in the thread but surface no content or
// author, so a soft delete actually removes the text from API responses.
function serializeComment(
  comment: ScanCommentRecord & Partial<Pick<ScanCommentEntry, "authorName" | "mentionedUserIds">>,
): PublicScanComment {
  const deleted = comment.deletedAt !== null;
  return {
    id: comment.id,
    scanId: comment.scanId,
    parentId: comment.parentId,
    authorUserId: deleted ? null : comment.authorUserId,
    authorName: deleted ? null : (comment.authorName ?? null),
    body: deleted ? "" : comment.body,
    anchorType: comment.anchorType,
    filePath: comment.filePath,
    line: comment.line,
    findingId: comment.findingId,
    mentionedUserIds: deleted ? [] : (comment.mentionedUserIds ?? []),
    deleted,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  };
}

async function getOrgScan(db: AppDb, scanId: string, organizationId: string) {
  const [scan] = await db
    .select({
      id: scans.id,
      packageName: scans.packageName,
      stagedVersion: scans.stagedVersion,
    })
    .from(scans)
    .where(and(eq(scans.id, scanId), eq(scans.organizationId, organizationId)))
    .limit(1);
  return scan ?? null;
}

interface ParsedAnchor {
  anchorType: CommentAnchorType;
  filePath: string | null;
  line: number | null;
  fileSha256: string | null;
  findingId: string | null;
}

async function parseAnchor(
  db: AppDb,
  scanId: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; anchor: ParsedAnchor } | { ok: false; error: string }> {
  const anchorType = body.anchorType ?? "general";
  if (!isCommentAnchorType(anchorType)) {
    return { ok: false, error: "anchorType must be one of: general, line, finding" };
  }
  if (anchorType === "general") {
    return {
      ok: true,
      anchor: { anchorType, filePath: null, line: null, fileSha256: null, findingId: null },
    };
  }
  if (anchorType === "line") {
    const filePath = typeof body.filePath === "string" ? body.filePath : "";
    const line = body.line;
    if (!filePath || typeof line !== "number" || !Number.isInteger(line) || line < 1) {
      return { ok: false, error: "line comments require filePath and a positive integer line" };
    }
    const [file] = await db
      .select({ path: scanFiles.path, sha256: scanFiles.sha256 })
      .from(scanFiles)
      .where(and(eq(scanFiles.scanId, scanId), eq(scanFiles.path, filePath)))
      .limit(1);
    if (!file) return { ok: false, error: "filePath does not exist in this scan" };
    return {
      ok: true,
      anchor: { anchorType, filePath, line, fileSha256: file.sha256, findingId: null },
    };
  }
  const findingId = typeof body.findingId === "string" ? body.findingId : "";
  if (!findingId) return { ok: false, error: "finding comments require findingId" };
  const [finding] = await db
    .select({ id: scanFindings.id, file: scanFindings.file, line: scanFindings.line })
    .from(scanFindings)
    .where(and(eq(scanFindings.scanId, scanId), eq(scanFindings.id, findingId)))
    .limit(1);
  if (!finding) return { ok: false, error: "findingId does not exist in this scan" };
  return {
    ok: true,
    anchor: {
      anchorType,
      filePath: finding.file,
      line: finding.line ?? null,
      fileSha256: null,
      findingId,
    },
  };
}

function parseBody(raw: unknown): { ok: true; body: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "body is required" };
  const body = raw.trim();
  if (!body) return { ok: false, error: "body is required" };
  if (body.length > COMMENT_BODY_MAX) {
    return { ok: false, error: `body must be at most ${COMMENT_BODY_MAX} characters` };
  }
  return { ok: true, body };
}

// Resolve mentions, persist the new ones, and queue best-effort emails on
// waitUntil so delivery never blocks the comment response.
async function dispatchMentions(options: {
  c: Context<{ Bindings: Bindings; Variables: Variables }>;
  db: AppDb;
  organizationId: string;
  scan: { id: string; packageName: string | null; stagedVersion: string | null };
  comment: ScanCommentRecord;
  authorUserId: string;
}): Promise<string[]> {
  const { c, db, organizationId, scan, comment, authorUserId } = options;
  const candidates = extractMentionUserIds(comment.body);
  const memberIds = await filterOrganizationMemberIds(db, organizationId, candidates);
  const mentioned = memberIds.filter((id) => id !== authorUserId);
  const added = await addCommentMentions(db, comment.id, mentioned);
  if (added.length > 0) {
    const author = await getUserContact(db, authorUserId);
    c.executionCtx.waitUntil(
      notifyCommentMention({
        env: c.env,
        db,
        organizationId,
        scanId: scan.id,
        commentId: comment.id,
        authorUserId,
        authorName: author?.name ?? null,
        packageName: scan.packageName,
        stagedVersion: scan.stagedVersion,
        anchor: comment.filePath ? { filePath: comment.filePath, line: comment.line } : null,
        body: comment.body,
        mentionedUserIds: added,
      }),
    );
  }
  return mentioned;
}

scanCommentsRoutes.get("/:scanId/comments", async (c) => {
  const db = createDb(c.env.DB);
  const { organizationId } = await requireActiveOrganizationContext(c, db);
  const scanId = c.req.param("scanId");
  const scan = await getOrgScan(db, scanId, organizationId);
  if (!scan) return c.json({ error: "scan not found" }, 404);
  const comments = await listScanComments(db, scanId, organizationId);
  return c.json({ comments: comments.map(serializeComment) });
});

scanCommentsRoutes.post("/:scanId/comments", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const { organizationId } = await requireActiveOrganizationContext(c, db);
  const scanId = c.req.param("scanId");
  const scan = await getOrgScan(db, scanId, organizationId);
  if (!scan) return c.json({ error: "scan not found" }, 404);

  const payload = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsedBody = parseBody(payload.body);
  if (!parsedBody.ok) return c.json({ error: parsedBody.error }, 400);
  const parsedAnchor = await parseAnchor(db, scanId, payload);
  if (!parsedAnchor.ok) return c.json({ error: parsedAnchor.error }, 400);

  let parentId: string | null = null;
  if (payload.parentId !== undefined && payload.parentId !== null) {
    if (typeof payload.parentId !== "string") {
      return c.json({ error: "parentId must be a comment id" }, 400);
    }
    const parent = await getScanComment(db, payload.parentId, scanId, organizationId);
    if (!parent || parent.deletedAt) {
      return c.json({ error: "parentId does not reference a comment on this scan" }, 400);
    }
    parentId = parent.id;
  }

  try {
    await enforceRateLimit(db, {
      key: `scan-comment:${organizationId}:${session.userId}`,
      limit: 30,
      windowMs: 60 * 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return rateLimitResponse(c, "comment rate limit exceeded", err);
    }
    throw err;
  }

  const comment = await createScanComment(db, {
    scanId,
    organizationId,
    authorUserId: session.userId,
    parentId,
    body: parsedBody.body,
    anchorType: parsedAnchor.anchor.anchorType,
    filePath: parsedAnchor.anchor.filePath,
    line: parsedAnchor.anchor.line,
    fileSha256: parsedAnchor.anchor.fileSha256,
    findingId: parsedAnchor.anchor.findingId,
  });

  const mentioned = await dispatchMentions({
    c,
    db,
    organizationId,
    scan,
    comment,
    authorUserId: session.userId,
  });

  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    scanId,
    type: "scan.comment_created",
    metadata: {
      commentId: comment.id,
      anchorType: comment.anchorType,
      ...(comment.filePath ? { filePath: comment.filePath, line: comment.line } : {}),
      ...(mentioned.length ? { mentionCount: mentioned.length } : {}),
    },
  });

  const author = await getUserContact(db, session.userId);
  return c.json(
    {
      comment: serializeComment({
        ...comment,
        authorName: author?.name ?? null,
        mentionedUserIds: mentioned,
      }),
    },
    201,
  );
});

scanCommentsRoutes.patch("/:scanId/comments/:commentId", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const { organizationId } = await requireActiveOrganizationContext(c, db);
  const scanId = c.req.param("scanId");
  const scan = await getOrgScan(db, scanId, organizationId);
  if (!scan) return c.json({ error: "scan not found" }, 404);

  const existing = await getScanComment(db, c.req.param("commentId"), scanId, organizationId);
  if (!existing || existing.deletedAt) return c.json({ error: "comment not found" }, 404);
  if (existing.authorUserId !== session.userId) {
    return c.json({ error: "only the author can edit a comment" }, 403);
  }

  const payload = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsedBody = parseBody(payload.body);
  if (!parsedBody.ok) return c.json({ error: parsedBody.error }, 400);

  const updated = await updateScanCommentBody(db, existing.id, parsedBody.body);
  if (!updated) return c.json({ error: "comment not found" }, 404);

  const mentioned = await dispatchMentions({
    c,
    db,
    organizationId,
    scan,
    comment: updated,
    authorUserId: session.userId,
  });

  const author = await getUserContact(db, session.userId);
  return c.json({
    comment: serializeComment({
      ...updated,
      authorName: author?.name ?? null,
      mentionedUserIds: mentioned,
    }),
  });
});

scanCommentsRoutes.delete("/:scanId/comments/:commentId", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  const scanId = c.req.param("scanId");
  const scan = await getOrgScan(db, scanId, organizationId);
  if (!scan) return c.json({ error: "scan not found" }, 404);

  const existing = await getScanComment(db, c.req.param("commentId"), scanId, organizationId);
  if (!existing || existing.deletedAt) return c.json({ error: "comment not found" }, 404);

  const isAuthor = existing.authorUserId === session.userId;
  if (!isAuthor && !roleCanManageMembers(role)) {
    return c.json({ error: "only the author or an organization admin can delete a comment" }, 403);
  }

  await softDeleteScanComment(db, existing.id);
  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    scanId,
    type: "scan.comment_deleted",
    metadata: { commentId: existing.id, byAuthor: isAuthor },
  });
  return c.json({ ok: true });
});
