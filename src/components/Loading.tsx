import { Card } from "./Card";
import { cn } from "./cn";
import { LoadingLine } from "./Typography";

export function IndeterminateBar({ class: className }: { class?: string }) {
  return (
    <div
      class={cn("relative h-1 w-full overflow-hidden rounded-sm bg-surface-2", className)}
      role="progressbar"
      aria-busy="true"
      aria-label="Loading"
    >
      <span
        class="absolute inset-y-0 left-0 w-1/3 rounded-sm bg-accent motion-safe:animate-progress-sweep"
        aria-hidden
      />
    </div>
  );
}

export function LoadingState({
  title,
  detail,
  class: className,
}: {
  title: string;
  detail?: string;
  class?: string;
}) {
  return (
    <Card class={cn("flex flex-col gap-4 p-5 md:p-6", className)}>
      <LoadingLine>{title}</LoadingLine>
      <IndeterminateBar />
      {detail ? (
        <p class="font-mono text-[11px] tracking-[0.02em] text-ink-subtle m-0">{detail}</p>
      ) : null}
    </Card>
  );
}
