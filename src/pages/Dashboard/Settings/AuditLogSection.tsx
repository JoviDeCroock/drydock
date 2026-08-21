import { useModel } from "@preact/signals";
import { formatTimestamp } from "../../../lib/format";
import {
  AuditLogModel,
  type AuditActor,
  type AuditCategory,
  type AuditEvent,
  type AuditSeverity,
} from "../../../models/audit-log";
import { Alert } from "../../../components/Alert";
import { Badge, type BadgeTone } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { CollapsibleCard, SettingsCardBody, SettingsCardListItem } from "../../../components/Card";
import { Muted } from "../../../components/Typography";

const CATEGORY_LABELS: Record<AuditCategory, string> = {
  release_decision: "Release",
  member: "Member",
  security: "Security",
  integration: "Integration",
  organization: "Org",
};

function auditSeverityTone(severity: AuditSeverity): BadgeTone {
  if (severity === "security") return "high";
  if (severity === "notice") return "medium";
  return "info";
}

function actorLabel(actor: AuditActor): string {
  if (actor.type === "system") return "System";
  return actor.name || actor.email || "Unknown user";
}

export function AuditLogSection({
  audit,
}: {
  audit: ReturnType<typeof useModel<typeof AuditLogModel.prototype>>;
}) {
  const events = audit.events.value;
  const loaded = audit.loaded.value;
  const status = audit.status.value;
  const error = audit.error.value;
  const hasMore = audit.hasMore.value;

  return (
    <CollapsibleCard
      title="Audit log"
      defaultOpen
      aside={
        <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
          {events.length}
          {hasMore ? "+" : ""} {events.length === 1 ? "event" : "events"}
        </span>
      }
    >
      <SettingsCardBody>
        <Muted class="text-[13px] m-0 max-w-[760px]">
          Release decisions, member changes, security policy, and integration changes for this
          organization. Events are retained for 90 days and visible to owners and admins.
        </Muted>
        {error ? <Alert tone="critical">{error}</Alert> : null}
      </SettingsCardBody>

      {loaded && !error && events.length === 0 ? (
        <SettingsCardBody inset="belowHeader" gap="none">
          <Muted class="text-[13px] m-0">No audit events yet.</Muted>
        </SettingsCardBody>
      ) : null}

      {!loaded && status === "loading" ? (
        <SettingsCardBody inset="belowHeader" gap="none">
          <Muted class="text-[13px] m-0">Loading audit log…</Muted>
        </SettingsCardBody>
      ) : null}

      {events.length ? (
        <ul class="list-none m-0 p-0">
          {events.map((event: AuditEvent) => (
            <SettingsCardListItem key={event.id}>
              <div class="flex flex-col gap-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <Badge tone={auditSeverityTone(event.severity)} dot>
                    {CATEGORY_LABELS[event.category]}
                  </Badge>
                  <span class="text-[13px] font-medium text-ink">{event.label}</span>
                </div>
                {event.detail ? (
                  <span class="text-[12px] text-ink-muted break-words">{event.detail}</span>
                ) : null}
                <span class="text-[11px] text-ink-subtle">
                  {actorLabel(event.actor)}
                  {event.scanId ? (
                    <>
                      {" · "}
                      <a
                        class="text-accent hover:underline"
                        href={`/dashboard/scans/${event.scanId}`}
                      >
                        view scan
                      </a>
                    </>
                  ) : null}
                </span>
              </div>
              <span class="font-mono text-[11px] text-ink-subtle shrink-0">
                {formatTimestamp(event.createdAt)}
              </span>
            </SettingsCardListItem>
          ))}
        </ul>
      ) : null}

      {hasMore ? (
        <SettingsCardBody inset="belowHeader" gap="none">
          <Button
            type="button"
            variant="secondary"
            disabled={audit.busy.value}
            onClick={() => void audit.loadMore()}
          >
            {status === "loadingMore" ? "Loading…" : "Load more"}
          </Button>
        </SettingsCardBody>
      ) : null}
    </CollapsibleCard>
  );
}
