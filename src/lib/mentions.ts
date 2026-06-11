// Comment bodies carry mentions as structured `@[userId]` tokens (see
// server/lib/comment-mentions.ts). These helpers split a body into renderable
// segments and handle composer-side token insertion, so display names are
// always resolved at render time from the current member list.

export type MentionSegment = { type: "text"; text: string } | { type: "mention"; userId: string };

const MENTION_TOKEN_RE = /@\[([A-Za-z0-9_.:-]{1,128})\]/g;

export function splitMentionSegments(body: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let last = 0;
  for (const match of body.matchAll(MENTION_TOKEN_RE)) {
    const index = match.index ?? 0;
    if (index > last) segments.push({ type: "text", text: body.slice(last, index) });
    segments.push({ type: "mention", userId: match[1] });
    last = index + match[0].length;
  }
  if (last < body.length) segments.push({ type: "text", text: body.slice(last) });
  return segments;
}

export interface MentionQuery {
  // index of the "@" that opened the query, in the composer text
  start: number;
  // the partial name typed after the "@", up to the caret
  query: string;
}

/**
 * Find an in-progress @-mention immediately before the caret: an "@" at the
 * start of a word followed only by name-ish characters. Returns null when the
 * caret isn't completing a mention (e.g. inside an email address or after a
 * finished `@[id]` token).
 */
export function activeMentionQuery(text: string, caret: number): MentionQuery | null {
  const upToCaret = text.slice(0, caret);
  const at = upToCaret.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/[\s([{]/.test(upToCaret[at - 1])) return null;
  const query = upToCaret.slice(at + 1);
  if (query.startsWith("[")) return null;
  if (!/^[^\s@]{0,64}$/.test(query)) return null;
  return { start: at, query };
}

/** Replace the active "@partial" with a `@[userId]` token plus trailing space. */
export function insertMentionToken(
  text: string,
  caret: number,
  start: number,
  userId: string,
): { text: string; caret: number } {
  const token = `@[${userId}] `;
  const next = text.slice(0, start) + token + text.slice(caret);
  return { text: next, caret: start + token.length };
}
