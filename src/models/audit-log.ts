import { computed, createModel, signal } from "@preact/signals";
import { apiFetch, errorMessage } from "./api";

export type AuditCategory =
  | "release_decision"
  | "member"
  | "security"
  | "integration"
  | "organization";

export type AuditSeverity = "info" | "notice" | "security";

export type AuditActor =
  | { type: "user"; name: string | null; email: string | null }
  | { type: "system" };

export interface AuditEvent {
  id: string;
  type: string;
  category: AuditCategory;
  label: string;
  severity: AuditSeverity;
  detail: string | null;
  createdAt: number;
  scanId: string | null;
  actor: AuditActor;
}

interface ListResponse {
  events: AuditEvent[];
  nextCursor: string | null;
  limit: number;
}

export type AuditLogStatus = "idle" | "loading" | "loadingMore";

const AUDIT_EVENTS_PATH = "/api/v1/audit-events";

export const AuditLogModel = createModel(() => {
  const events = signal<AuditEvent[]>([]);
  const loaded = signal(false);
  const status = signal<AuditLogStatus>("idle");
  const error = signal<string | null>(null);
  const nextCursor = signal<string | null>(null);
  let loadRequestId = 0;

  const busy = computed(() => status.value !== "idle");
  const hasMore = computed(() => nextCursor.value !== null);

  return {
    events,
    loaded,
    status,
    error,
    nextCursor,
    busy,
    hasMore,

    // `enabled` gates the fetch on owner/admin access so members never hit the
    // 403 endpoint. The request itself is org-scoped via the active-org header.
    async load(enabled: boolean): Promise<void> {
      const requestId = ++loadRequestId;
      this.events.value = [];
      this.nextCursor.value = null;
      this.error.value = null;
      this.loaded.value = false;
      if (!enabled) {
        this.loaded.value = true;
        this.status.value = "idle";
        return;
      }
      this.status.value = "loading";
      try {
        const data = await apiFetch<ListResponse>(AUDIT_EVENTS_PATH);
        if (requestId === loadRequestId) {
          this.events.value = data.events;
          this.nextCursor.value = data.nextCursor;
        }
      } catch (err) {
        if (requestId === loadRequestId) this.error.value = errorMessage(err);
      } finally {
        if (requestId === loadRequestId) {
          this.loaded.value = true;
          this.status.value = "idle";
        }
      }
    },

    async loadMore(): Promise<void> {
      const cursor = this.nextCursor.peek();
      if (!cursor || this.status.peek() !== "idle") return;
      const requestId = loadRequestId;
      this.status.value = "loadingMore";
      this.error.value = null;
      try {
        const data = await apiFetch<ListResponse>(
          `${AUDIT_EVENTS_PATH}?cursor=${encodeURIComponent(cursor)}`,
        );
        if (requestId === loadRequestId) {
          this.events.value = [...this.events.value, ...data.events];
          this.nextCursor.value = data.nextCursor;
        }
      } catch (err) {
        if (requestId === loadRequestId) this.error.value = errorMessage(err);
      } finally {
        if (requestId === loadRequestId) this.status.value = "idle";
      }
    },
  };
});
