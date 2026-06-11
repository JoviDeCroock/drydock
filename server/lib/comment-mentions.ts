// Mention handling for scan comments. Mentions travel inside the comment body
// as structured `@[userId]` tokens — the UI resolves them to display names at
// render time, so a member rename never goes stale and the server never has to
// parse free-form display names out of text.

export const COMMENT_BODY_MAX = 4000;

export const COMMENT_ANCHOR_TYPES = ["general", "line", "finding"] as const;
export type CommentAnchorType = (typeof COMMENT_ANCHOR_TYPES)[number];

// User ids are opaque (Better Auth ids, `user_<uuid>` in fixtures); the charset
// is restricted so a crafted body can't smuggle markup through a token.
const MENTION_TOKEN_RE = /@\[([A-Za-z0-9_.:-]{1,128})\]/g;

export function extractMentionUserIds(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(MENTION_TOKEN_RE)) {
    const userId = match[1];
    if (userId) seen.add(userId);
  }
  return [...seen];
}

export function isCommentAnchorType(value: unknown): value is CommentAnchorType {
  return COMMENT_ANCHOR_TYPES.includes(value as CommentAnchorType);
}
