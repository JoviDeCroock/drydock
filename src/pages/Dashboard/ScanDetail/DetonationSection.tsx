import { useModel, useSignal } from "@preact/signals";
import type { DetonationResult, DetonationSignal } from "../../../../server/lib/detonation/types";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import {
  EmptyLine,
  LoadingLine,
  MonoDetail,
  MonoLabel,
  SectionLabel,
} from "../../../components/Typography";
import { pluralize } from "../../../lib/format";
import { ScanDetonationModel } from "../../../models/scan";
import {
  coverageParts,
  detonationView,
  signalNeedsBadge,
  signalSourceHint,
  weakCleanResult,
} from "./detonation-view";

const EVIDENCE_PREVIEW_LINES = 3;

/**
 * Beta detonation results. Advisory: nothing here feeds the scan's risk,
 * findings, or decision. Renders nothing for organizations outside the beta.
 * Evidence lines come from a sandbox running the package, so they render as
 * plain text children only.
 */
export function DetonationSection({ scanId }: { scanId: string }) {
  const model = useModel(() => new ScanDetonationModel(scanId));
  const hidden = model.hidden.value;
  const data = model.data.value;
  const loadError = model.loadError.value;
  const requesting = model.requesting.value;
  const requestError = model.requestError.value;
  const result = model.run.value?.result ?? null;
  const view = detonationView(data);
  // A first load that failed stays silent: the beta should not surface on a
  // transient error for organizations that may not be in it.
  if (hidden || view.kind === "hidden") return null;

  const runButton =
    "canRun" in view && view.canRun ? (
      <Button
        variant="secondary"
        size="sm"
        disabled={requesting}
        onClick={() => void model.requestRun()}
      >
        {requesting ? "Starting…" : view.kind === "not-run" ? "Run detonation" : "Run again"}
      </Button>
    ) : null;

  return (
    <section class="flex flex-col gap-3 min-w-0" aria-label="Detonation">
      <SectionLabel as="h3" aside="beta">
        Detonation
      </SectionLabel>
      <p class="m-0 text-[12px] leading-[1.5] text-ink-muted max-w-[680px]">
        Installs and loads the package in an isolated sandbox with planted fake credentials.
        Advisory: it does not change the risk or the decision.
      </p>

      {view.kind === "pending" ? (
        <LoadingLine size="inline">{view.label}</LoadingLine>
      ) : (
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p
            class={
              view.kind === "complete"
                ? "m-0 text-[14px] font-medium text-ink"
                : "m-0 text-[13px] leading-[1.55] text-ink-muted"
            }
          >
            {headline(view)}
          </p>
          {runButton}
        </div>
      )}
      {requestError ? <p class="m-0 text-[12px] text-danger-text">{requestError}</p> : null}
      {loadError && data ? (
        <p class="m-0 text-[12px] text-ink-muted">Could not refresh: {loadError}</p>
      ) : null}

      {view.kind === "complete" && view.signals.length ? (
        <ul class="list-none p-0 m-0 flex flex-col gap-3 max-w-[680px]">
          {view.signals.map((signal, index) => (
            <SignalItem key={`${signal.id}:${index}`} signal={signal} />
          ))}
        </ul>
      ) : null}
      {view.kind === "complete" ? (
        <>
          <MonoDetail parts={coverageParts(view.coverage, view.truncated)} />
          {!view.signals.length && weakCleanResult(view.coverage, view.truncated) ? (
            <p class="m-0 text-[12px] text-ink-muted">
              Limited coverage makes a clean run weaker evidence.
            </p>
          ) : null}
        </>
      ) : null}
      {result && (result.egress.length || result.steps.length) ? (
        <SandboxLog result={result} />
      ) : null}
    </section>
  );
}

function headline(view: ReturnType<typeof detonationView>): string {
  switch (view.kind) {
    case "not-run":
      return "Not run for this release.";
    case "stalled":
    case "unfinished":
      return view.message;
    case "complete":
      return view.signals.length
        ? `${view.signals.length} suspicious ${pluralize("behavior", view.signals.length)} observed`
        : "No suspicious behavior observed";
    default:
      return "";
  }
}

function SignalItem({ signal }: { signal: DetonationSignal }) {
  const expanded = useSignal(false);
  const lines = expanded.value ? signal.evidence : signal.evidence.slice(0, EVIDENCE_PREVIEW_LINES);
  const toggleLabel = expanded.value ? "Show fewer" : `Show all ${signal.evidence.length}`;
  return (
    <li class="flex flex-col gap-1 min-w-0">
      <p class="m-0 flex flex-wrap items-center gap-x-2 gap-y-1">
        {signalNeedsBadge(signal.severity) ? (
          <Badge tone={signal.severity}>{signal.severity}</Badge>
        ) : (
          <MonoLabel>{signal.severity}</MonoLabel>
        )}
        <span class="text-[13px] font-medium text-ink break-words">{signal.title}</span>
      </p>
      <p class="m-0 text-[12px] text-ink-muted">
        {signalSourceHint(signal.source)}
        {signal.step ? ` · during ${signal.step}` : ""}
      </p>
      {lines.length ? (
        <ul class="list-none p-0 m-0 flex flex-col gap-0.5 font-mono text-[12px] text-ink-muted">
          {lines.map((line, index) => (
            <li key={index} class="break-all">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
      {signal.evidence.length > EVIDENCE_PREVIEW_LINES ? (
        <button
          type="button"
          onClick={() => (expanded.value = !expanded.peek())}
          class="self-start p-0 border-0 bg-transparent text-[12px] text-accent hover:underline cursor-pointer"
        >
          {toggleLabel}
        </button>
      ) : null}
    </li>
  );
}

function SandboxLog({ result }: { result: DetonationResult }) {
  return (
    <details>
      <summary class="cursor-pointer text-[13px] text-ink-muted hover:text-ink">
        Sandbox log · {result.egress.length} {pluralize("request", result.egress.length)} ·{" "}
        {result.steps.length} {pluralize("step", result.steps.length)}
      </summary>
      <div class="mt-3 flex flex-col gap-4 max-w-[680px]">
        <div class="flex flex-col gap-1.5">
          <MonoLabel as="p">Network requests</MonoLabel>
          {result.egress.length ? (
            <ul class="list-none p-0 m-0 flex flex-col gap-1 font-mono text-[12px] text-ink-muted">
              {result.egress.map((event, index) => (
                <li key={index} class="break-all">
                  <span class="text-ink">
                    {event.method} {event.host}
                    {event.path}
                  </span>
                  {` · ${event.phase} · ${event.bodyBytes} B · ${event.action}`}
                  {event.canaryHits.length ? (
                    <span class="text-danger-text">
                      {` · canary ${event.canaryHits.join(", ")}`}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyLine>No network requests were made.</EmptyLine>
          )}
        </div>
        {result.steps.length ? (
          <div class="flex flex-col gap-1.5">
            <MonoLabel as="p">Steps</MonoLabel>
            <ul class="list-none p-0 m-0 flex flex-col gap-1 font-mono text-[12px] text-ink-muted">
              {result.steps.map((step, index) => (
                <li key={index} class="break-all">
                  <span class="text-ink">{step.target}</span>
                  {step.timedOut
                    ? " · timed out"
                    : ` · exit ${step.exitCode === null ? "none" : step.exitCode}`}
                  {` · ${step.durationMs} ms`}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </details>
  );
}
