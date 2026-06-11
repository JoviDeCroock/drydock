import { Fragment } from "preact";
import { useComputed, useSignal, type ReadonlySignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import {
  activeMentionQuery,
  insertMentionToken,
  splitMentionSegments,
} from "../../../lib/mentions";
import type { OrganizationMember } from "../../../models/organization-members";
import type { ScanComment, ScanCommentsModelInstance } from "../../../models/scan-comments";
import { Alert, Button, Card, Muted, SectionLabel } from "../../../components";

// Team discussion on a scan: a chronological comment list plus a composer with
// @-mention autocomplete. Line comments started from the diff ("+" on a staged
// line) land here as a pending anchor chip on the composer.
export function DiscussionSection({
  model,
  members,
  currentUserId,
  canModerate,
  onSelectPath,
}: {
  model: ScanCommentsModelInstance;
  members: ReadonlySignal<OrganizationMember[]>;
  currentUserId: string | null;
  canModerate: boolean;
  onSelectPath: (path: string) => void;
}) {
  const comments = model.visibleComments.value;
  const error = model.error.value;
  const nameFor = (userId: string | null, fallback: string | null) => {
    if (!userId) return fallback ?? "former member";
    const member = members.value.find((entry) => entry.userId === userId);
    return member?.name || member?.email || fallback || "former member";
  };

  return (
    <div id="discussion">
      <Card class="p-5 flex flex-col gap-4">
        <SectionLabel>Discussion</SectionLabel>
        {error ? <Alert tone="critical">{error}</Alert> : null}
        {comments.length === 0 ? (
          <Muted class="text-[13px]">
            No comments yet. Start the discussion — mention teammates with @ to loop them in.
          </Muted>
        ) : (
          <ol class="m-0 p-0 list-none flex flex-col divide-y divide-border">
            {comments.map((comment) => (
              <CommentItem
                key={comment.id}
                comment={comment}
                authorLabel={nameFor(comment.authorUserId, comment.authorName)}
                nameFor={nameFor}
                canDelete={canModerate || comment.authorUserId === currentUserId}
                busy={model.status.value === "deleting"}
                onDelete={() => void model.remove(comment.id)}
                onSelectPath={onSelectPath}
              />
            ))}
          </ol>
        )}
        <CommentComposer model={model} members={members} />
      </Card>
    </div>
  );
}

export function commentAnchorLabel(comment: Pick<ScanComment, "filePath" | "line">): string | null {
  if (!comment.filePath) return null;
  return comment.line != null ? `${comment.filePath}:${comment.line}` : comment.filePath;
}

function CommentItem({
  comment,
  authorLabel,
  nameFor,
  canDelete,
  busy,
  onDelete,
  onSelectPath,
}: {
  comment: ScanComment;
  authorLabel: string;
  nameFor: (userId: string | null, fallback: string | null) => string;
  canDelete: boolean;
  busy: boolean;
  onDelete: () => void;
  onSelectPath: (path: string) => void;
}) {
  const anchorLabel = commentAnchorLabel(comment);
  return (
    <li class="py-3 flex flex-col gap-1" id={`comment-${comment.id}`}>
      <div class="flex flex-wrap items-baseline gap-2">
        <span class="text-[13px] font-medium text-ink">{authorLabel}</span>
        <span class="font-mono text-[11px] text-ink-subtle">
          {formatCommentTime(comment.createdAt)}
        </span>
        {anchorLabel && comment.filePath ? (
          <button
            type="button"
            class="font-mono text-[11px] text-accent bg-transparent border-0 p-0 cursor-pointer hover:underline"
            onClick={() => onSelectPath(comment.filePath as string)}
          >
            {anchorLabel}
          </button>
        ) : null}
        {canDelete ? (
          <button
            type="button"
            class="ml-auto font-mono text-[11px] text-ink-subtle bg-transparent border-0 p-0 cursor-pointer hover:text-danger disabled:opacity-60"
            disabled={busy}
            onClick={onDelete}
          >
            delete
          </button>
        ) : null}
      </div>
      <p class="m-0 text-[13px] leading-[1.55] text-ink whitespace-pre-wrap break-words">
        {splitMentionSegments(comment.body).map((segment, index) =>
          segment.type === "mention" ? (
            <span key={index} class="text-accent font-medium">
              @{nameFor(segment.userId, null)}
            </span>
          ) : (
            <Fragment key={index}>{segment.text}</Fragment>
          ),
        )}
      </p>
    </li>
  );
}

function CommentComposer({
  model,
  members,
}: {
  model: ScanCommentsModelInstance;
  members: ReadonlySignal<OrganizationMember[]>;
}) {
  const text = useSignal("");
  const caret = useSignal(0);
  const mention = useComputed(() => activeMentionQuery(text.value, caret.value));
  const suggestions = useComputed(() => {
    const active = mention.value;
    const memberList = members.value;
    if (!active) return [];
    const query = active.query.toLowerCase();
    return memberList
      .filter((member) => {
        const label = `${member.name ?? ""} ${member.email ?? ""}`.toLowerCase();
        return query === "" || label.includes(query);
      })
      .slice(0, 6);
  });

  const pendingAnchor = model.pendingAnchor.value;
  const posting = model.status.value === "posting";

  const syncFromTextarea = (target: HTMLTextAreaElement) => {
    text.value = target.value;
    caret.value = target.selectionStart ?? target.value.length;
  };

  const pickSuggestion = (member: OrganizationMember) => {
    const active = mention.peek();
    if (!active) return;
    const next = insertMentionToken(text.peek(), caret.peek(), active.start, member.userId);
    text.value = next.text;
    caret.value = next.caret;
  };

  const submit = async () => {
    const body = text.peek().trim();
    if (!body) return;
    const anchor = model.pendingAnchor.peek();
    const ok = await model.post(
      body,
      anchor
        ? { anchorType: "line", filePath: anchor.filePath, line: anchor.line }
        : { anchorType: "general" },
    );
    if (ok) {
      text.value = "";
      caret.value = 0;
    }
  };

  return (
    <div class="flex flex-col gap-2 border-t border-border pt-3">
      {pendingAnchor ? (
        <div class="flex items-center gap-2">
          <span class="font-mono text-[11px] text-accent">
            commenting on {pendingAnchor.filePath}:{pendingAnchor.line}
          </span>
          <button
            type="button"
            class="font-mono text-[11px] text-ink-subtle bg-transparent border-0 p-0 cursor-pointer hover:text-ink"
            onClick={() => model.setPendingAnchor(null)}
          >
            × clear
          </button>
        </div>
      ) : null}
      <div class="relative">
        <textarea
          class="w-full bg-bg border border-border rounded-md text-[13px] text-ink px-3 py-2 outline-none transition-[border-color,box-shadow] duration-150 ease-out placeholder:text-ink-subtle focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-soft)] min-h-[72px] resize-y"
          placeholder="Leave a comment — type @ to mention a teammate"
          value={text.value}
          disabled={posting}
          onInput={(e) => syncFromTextarea(e.target as HTMLTextAreaElement)}
          onClick={(e) => syncFromTextarea(e.target as HTMLTextAreaElement)}
          onKeyUp={(e) => syncFromTextarea(e.target as HTMLTextAreaElement)}
        />
        <Show when={() => Boolean(mention.value && suggestions.value.length)}>
          {() => (
            <ul class="absolute left-0 top-full z-10 mt-1 m-0 p-1 list-none min-w-[220px] bg-bg border border-border rounded-md shadow-md flex flex-col">
              {suggestions.value.map((member) => (
                <li key={member.userId}>
                  <button
                    type="button"
                    class="w-full text-left px-2 py-1.5 rounded text-[13px] text-ink bg-transparent border-0 cursor-pointer hover:bg-surface-2 flex items-baseline gap-2"
                    onClick={() => pickSuggestion(member)}
                  >
                    <span class="font-medium">{member.name || member.email || member.userId}</span>
                    {member.name && member.email ? (
                      <span class="font-mono text-[11px] text-ink-subtle">{member.email}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Show>
      </div>
      <div class="flex justify-end">
        <Button size="sm" disabled={posting || !text.value.trim()} onClick={() => void submit()}>
          {posting ? "Posting…" : "Comment"}
        </Button>
      </div>
    </div>
  );
}

function formatCommentTime(value: string | number | Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
