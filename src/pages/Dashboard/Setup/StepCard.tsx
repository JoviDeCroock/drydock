import type { ComponentChildren } from "preact";
import { Badge, Card, Muted } from "../../../components";

export type StepStatus = "done" | "todo" | "manual";

/**
 * One step in a guided-setup flow. Steps render as a vertical stack rather than
 * a step machine: each lights up `done` as its backing model state is satisfied,
 * so the flow is mostly "confirm" rather than "fill in a form". Generate/manual
 * steps (workflow YAML, npmjs.com / GitHub config) carry a neutral `manual`
 * badge because Drydock can't observe their completion.
 */
export function StepCard({
  index,
  title,
  status,
  summary,
  children,
}: {
  index: string;
  title: string;
  status: StepStatus;
  summary?: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <Card as="section" class="p-5">
      <div class="flex items-start gap-3">
        <span class="font-mono text-[11px] text-ink-subtle tabular-nums mt-1 shrink-0">
          {index}
        </span>
        <div class="flex-1 min-w-0 flex flex-col gap-4">
          <div class="flex items-start justify-between gap-3">
            <div class="flex flex-col gap-1 min-w-0">
              <h2 class="text-[16px] font-medium tracking-[-0.005em] m-0">{title}</h2>
              {summary ? <Muted class="text-[13px] m-0">{summary}</Muted> : null}
            </div>
            <StepBadge status={status} />
          </div>
          <div class="flex flex-col gap-4 min-w-0">{children}</div>
        </div>
      </div>
    </Card>
  );
}

function StepBadge({ status }: { status: StepStatus }) {
  switch (status) {
    case "done":
      return <Badge tone="ok">done</Badge>;
    case "manual":
      return <Badge tone="info">manual</Badge>;
    case "todo":
      return <Badge tone="neutral">to do</Badge>;
  }
}

/** Bulleted manual checklist used inside setup steps Drydock can't observe. */
export function Checklist({ items }: { items: ComponentChildren[] }) {
  return (
    <ul class="m-0 p-0 list-none flex flex-col gap-2">
      {items.map((item, index) => (
        <li
          key={index}
          class="grid grid-cols-[16px_minmax(0,1fr)] gap-2.5 items-baseline text-[13px] leading-[1.55] text-ink-muted"
        >
          <span class="font-mono text-ink-subtle" aria-hidden>
            •
          </span>
          <span class="min-w-0">{item}</span>
        </li>
      ))}
    </ul>
  );
}
