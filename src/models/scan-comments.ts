import { computed, createModel, signal } from "@preact/signals";
import { apiFetch, apiJson, errorMessage } from "./api";

export interface ScanComment {
  id: string;
  scanId: string;
  parentId: string | null;
  authorUserId: string | null;
  authorName: string | null;
  body: string;
  anchorType: "general" | "line" | "finding" | string;
  filePath: string | null;
  line: number | null;
  findingId: string | null;
  mentionedUserIds: string[];
  deleted: boolean;
  createdAt: string | number | Date;
  updatedAt: string | number | Date;
}

export interface CommentAnchorInput {
  anchorType: "general" | "line" | "finding";
  filePath?: string;
  line?: number;
  findingId?: string;
}

// A line the user clicked "comment" on in the diff; the Discussion composer
// picks it up as the pending anchor.
export interface PendingLineAnchor {
  filePath: string;
  line: number;
}

type CommentsStatus = "idle" | "loading" | "posting" | "deleting";

export const ScanCommentsModel = createModel((scanId: string) => {
  const comments = signal<ScanComment[]>([]);
  const loaded = signal(false);
  const status = signal<CommentsStatus>("idle");
  const error = signal<string | null>(null);
  const pendingAnchor = signal<PendingLineAnchor | null>(null);
  const visibleComments = computed(() => comments.value.filter((comment) => !comment.deleted));

  const base = `/api/v1/scans/${encodeURIComponent(scanId)}/comments`;

  return {
    comments,
    visibleComments,
    loaded,
    status,
    error,
    pendingAnchor,

    async load(): Promise<void> {
      status.value = "loading";
      try {
        const data = await apiFetch<{ comments: ScanComment[] }>(base);
        comments.value = data.comments;
        error.value = null;
      } catch (err) {
        error.value = errorMessage(err);
      } finally {
        loaded.value = true;
        status.value = "idle";
      }
    },

    async post(body: string, anchor: CommentAnchorInput): Promise<boolean> {
      status.value = "posting";
      error.value = null;
      try {
        const data = await apiJson<{ comment: ScanComment }>(base, { body, ...anchor });
        comments.value = [...comments.peek(), data.comment];
        pendingAnchor.value = null;
        return true;
      } catch (err) {
        error.value = errorMessage(err);
        return false;
      } finally {
        status.value = "idle";
      }
    },

    async remove(commentId: string): Promise<void> {
      status.value = "deleting";
      error.value = null;
      try {
        await apiFetch(`${base}/${encodeURIComponent(commentId)}`, { method: "DELETE" });
        comments.value = comments.peek().filter((comment) => comment.id !== commentId);
      } catch (err) {
        error.value = errorMessage(err);
      } finally {
        status.value = "idle";
      }
    },

    setPendingAnchor(anchor: PendingLineAnchor | null): void {
      pendingAnchor.value = anchor;
    },
  };
});

export type ScanCommentsModelInstance = InstanceType<typeof ScanCommentsModel>;
