import { useModel } from "@preact/signals";
import { formatDateTimeExact } from "../../../lib/format";
import { scanDetailPath } from "../../../lib/scan-detail-path";
import {
  AuditLogModel,
  type AuditActor,
  type AuditCategory,
  type AuditEvent,
} from "../../../models/audit-log";
import { Alert } from "../../../components/Alert";
import { cn } from "../../../components/cn";
import { LoadMoreButton } from "../../../components/Button";
import { Card, SettingsCardBody, SettingsCardListItem } from "../../../components/Card";
import { MonoLabel, Muted, SectionLabel } from "../../../components/Typography";

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
  organizationId,
}: {
  audit: ReturnType<typeof useModel<typeof AuditLogModel.prototype>>;
  /** The organization the events were read for; their reviews belong to it. */
  organizationId?: string | null;
}) {
  const events = audit.events.value;
  const loaded = audit.loaded.value;
  const status = audit.status.value;
  const error = audit.error.value;
  const hasMore = audit.hasMore.value;

  return (
    // The only section on its tab, so it is a plain card: collapsing it would
    // leave the tab empty.
    <Card as="section" padding="none">
      <div class="px-5 py-4">
        <SectionLabel
          as="h2"
          aside={
            events.length ? (
              <MonoLabel>
                {events.length}
                {hasMore ? "+" : ""} {events.length === 1 ? "event" : "events"}
              </MonoLabel>
            ) : undefined
          }
        >
          Audit log
        </SectionLabel>
      </div>
      <SettingsCardBody>
        <Muted class="text-[13px] m-0 max-w-[680px]">
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
          {events.map((event: AuditEvent) => {
            // The subject (usually name@version) is the link into its review;
            // an event with a review but no subject still gets a way in.
            const subject = event.detail || (event.scanId ? "Open review" : null);
            return (
              <SettingsCardListItem key={event.id}>
                <div class="flex flex-col gap-1 min-w-0 flex-1">
                  {/* The timestamp shares the title's baseline so a long subject
                      never pulls it off the row it dates. */}
                  <div class="flex items-baseline justify-between gap-3">
                    <div class="flex items-baseline gap-2 flex-wrap min-w-0">
                      <MonoLabel>{CATEGORY_LABELS[event.category]}</MonoLabel>
                      <span class="text-[13px] font-medium text-ink">{event.label}</span>
                    </div>
                    <time
                      class="font-mono text-[11px] text-ink-subtle shrink-0"
                      dateTime={new Date(event.createdAt).toISOString()}
                    >
                      {formatDateTimeExact(event.createdAt)}
                    </time>
                  </div>
                  <p class="m-0 text-[13px] leading-[1.55] text-ink-muted flex flex-wrap gap-x-2">
                    {subject ? (
                      event.scanId ? (
                        <a
                          class={cn(
                            "text-ink hover:text-accent underline decoration-border underline-offset-2 break-all",
                            event.detail && "font-mono text-[12px]",
                          )}
                          href={scanDetailPath(event.scanId, organizationId)}
                        >
                          {subject}
                        </a>
                      ) : (
                        <span class="font-mono text-[12px] text-ink break-all">{subject}</span>
                      )
                    ) : null}
                    <span>by {actorLabel(event.actor)}</span>
                  </p>
                </div>
              </SettingsCardListItem>
            );
          })}
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
    </Card>
  );
}
