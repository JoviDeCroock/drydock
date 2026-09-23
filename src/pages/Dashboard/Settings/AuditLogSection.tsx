import { useModel } from "@preact/signals";
import { formatTimestamp } from "../../../lib/format";
import {
  AuditLogModel,
  type AuditActor,
  type AuditCategory,
  type AuditEvent,
} from "../../../models/audit-log";
import { Alert } from "../../../components/Alert";
import { LoadMoreButton } from "../../../components/Button";
import { CollapsibleCard, SettingsCardBody, SettingsCardListItem } from "../../../components/Card";
import { MonoDetail, MonoLabel, Muted } from "../../../components/Typography";

const CATEGORY_LABELS: Record<AuditCategory, string> = {
  release_decision: "Release",
  member: "Member",
  security: "Security",
  integration: "Integration",
  organization: "Org",
};

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
        events.length ? (
          <MonoLabel>
            {events.length}
            {hasMore ? "+" : ""} {events.length === 1 ? "event" : "events"}
          </MonoLabel>
        ) : null
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
              <div class="flex flex-col gap-1 min-w-0 flex-1">
                {/* The timestamp shares the title's baseline so a long detail line
                    never pulls it off the row it dates. */}
                <div class="flex items-baseline justify-between gap-3">
                  <div class="flex items-baseline gap-2 flex-wrap min-w-0">
                    <MonoLabel>{CATEGORY_LABELS[event.category]}</MonoLabel>
                    <span class="text-[13px] font-medium text-ink">{event.label}</span>
                  </div>
                  <span class="font-mono text-[11px] text-ink-subtle shrink-0">
                    {formatTimestamp(event.createdAt)}
                  </span>
                </div>
                <MonoDetail
                  parts={[
                    event.detail ? (
                      <span key="detail" class="break-words">
                        {event.detail}
                      </span>
                    ) : null,
                    <span key="actor">{actorLabel(event.actor)}</span>,
                    event.scanId ? (
                      <a
                        key="scan"
                        class="text-accent hover:underline"
                        href={`/dashboard/scans/${event.scanId}`}
                      >
                        view scan
                      </a>
                    ) : null,
                  ]}
                />
              </div>
            </SettingsCardListItem>
          ))}
        </ul>
      ) : null}

      {hasMore ? (
        <SettingsCardBody inset="belowHeader" gap="none">
          <LoadMoreButton
            size="md"
            loading={status === "loadingMore"}
            disabled={audit.busy}
            onClick={() => void audit.loadMore()}
          />
        </SettingsCardBody>
      ) : null}
    </CollapsibleCard>
  );
}
