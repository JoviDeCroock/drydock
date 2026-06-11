# Scan comments and mentions

Completed scans carry a team discussion: general comments, comments anchored to
a staged line in the diff, and comments anchored to a finding. Members can
@-mention teammates, and mentioned users get a best-effort email (opt-out per
user).

## Data model

- `scan_comments` — one row per comment, scoped by `scan_id` and
  `organization_id`. Anchors: `anchor_type` of `general`, `line`
  (`file_path` + `line`, with the staged file's `sha256` captured at write time
  — scans are immutable, so anchors never go stale), or `finding`
  (`finding_id`, which also denormalizes the finding's file/line for inline
  rendering). `parent_id` supports replies. Deletes are soft (`deleted_at`);
  the API serializes tombstones with the body and author redacted.
- `scan_comment_mentions` — one row per (comment, mentioned user), unique.
  `notified_at` records successful email delivery, making notification
  idempotent: editing a comment only notifies _newly added_ mentions.
- `user_notification_settings` — per-user preferences keyed by `user_id`.
  `mention_emails` defaults to true; absence of a row means defaults.

Organization deletion and account deletion clean these tables up explicitly
(D1 does not enforce foreign keys); comments by a deleted account survive with
`author_user_id` nulled, rendered as "former member".

## API

- `GET/POST /api/v1/scans/:scanId/comments` — list / create. Creation
  validates the anchor against the scan's files/findings, caps bodies at 4000
  chars, and is rate-limited per user per organization (30/h).
- `PATCH/DELETE /api/v1/scans/:scanId/comments/:commentId` — author-only edit;
  delete by the author or an owner/admin.
- `GET/PATCH /api/v1/account/notification-settings` — the per-user mention
  email toggle (surfaced on the Account page).

All routes resolve the scan through the active organization
(`x-organization-id`), so cross-org access yields 404.

## Mentions

Mentions are stored as structured `@[userId]` tokens in the body, never display
names. The server resolves tokens to organization members and silently drops
non-members (prevents user-id enumeration); the UI's composer autocomplete
(type `@`) inserts tokens and renders them as highlighted `@Name` resolved from
the live member list. Mention emails (`server/lib/notify.ts`
`notifyCommentMention`) are dispatched on `waitUntil`, carry only the comment
text and a `path:line` label — never scan evidence — and record
`scan.comment_mention_sent` / `_failed` audit events.

## UI

The scan detail page shows a Discussion card under the report sections.
Line-anchored comments also render inline in the diff beneath their staged
line; hovering a staged line's number shows a `+` affordance that pre-fills the
composer's anchor chip.
