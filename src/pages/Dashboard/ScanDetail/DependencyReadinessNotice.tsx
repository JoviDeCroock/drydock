import { useComputed, useModel } from "@preact/signals";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import {
  dependencyIssueMessage,
  dependencyReadinessApplies,
  dependencyReadinessHeadline,
  dependencyReadinessView,
  dependencySectionLabel,
  uncheckedDependenciesMessage,
} from "../../../features/dependency-readiness";
import { scanDetailPath } from "../../../lib/scan-detail-path";
import { DependencyReadinessModel } from "../../../models/dependency-readiness";
import type { ScanDetailModelInstance } from "../../../models/scan";

/**
 * Sits directly under the verdict strip, beside the decision it informs:
 * approving a release whose dependency is still staged leaves it uninstallable
 * for every consumer. Renders nothing for a clean or inapplicable check — a
 * reassurance line here would only compete with the decision.
 */
export function DependencyReadinessNotice({ model }: { model: ScanDetailModelInstance }) {
  const enabled = useComputed(() =>
    dependencyReadinessApplies(model.detail.value?.scan, model.gate.value?.status),
  );
  const readiness = useModel(() => new DependencyReadinessModel(model.scanId.peek(), enabled));
  if (!enabled.value) return null;

  const organizationId = model.detail.value?.scan.organizationId ?? null;
  const loading = readiness.loading.value;
  const checkAgain = (
    <Button variant="ghost" size="sm" disabled={loading} onClick={() => void readiness.refresh()}>
      {loading ? "Checking…" : "Check again"}
    </Button>
  );

  if (readiness.failed.value) {
    return (
      <p class="m-0 flex flex-wrap items-center gap-2 text-[13px] text-ink-muted">
        Could not check whether this release&rsquo;s dependencies are installable yet.
        {checkAgain}
      </p>
    );
  }

  const view = dependencyReadinessView(readiness.result.value);
  if (!view) return null;

  if (!view.blocking.length) {
    return (
      <p class="m-0 flex flex-wrap items-center gap-2 text-[13px] text-ink-muted">
        {uncheckedDependenciesMessage(view.unchecked)}
        {checkAgain}
      </p>
    );
  }

  const headline = dependencyReadinessHeadline(view);
  return (
    <Alert tone={view.tone}>
      <div class="flex flex-col gap-2">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div class="flex flex-col gap-1">
            <strong>{headline.title}</strong>
            <span>{headline.consequence}</span>
          </div>
          {checkAgain}
        </div>
        <ul class="m-0 p-0 list-none flex flex-col gap-1.5">
          {view.blocking.map((issue) => {
            const section = dependencySectionLabel(issue);
            return (
              <li key={`${issue.section}:${issue.name}`} class="flex flex-col gap-0.5">
                <span class="flex flex-wrap items-baseline gap-x-2">
                  <code class="font-mono text-[12px] text-ink">{issue.name}</code>
                  <code class="font-mono text-[12px] text-ink-muted break-all">{issue.spec}</code>
                  {section ? (
                    <span class="font-mono text-[11px] text-ink-subtle">{section}</span>
                  ) : null}
                </span>
                <span class="text-ink-muted">
                  {dependencyIssueMessage(issue, { credentialed: view.credentialed })}
                  {issue.staged ? (
                    <>
                      {" "}
                      <a
                        class="font-mono text-[12px] underline text-accent"
                        href={scanDetailPath(issue.staged.scanId, organizationId)}
                      >
                        review →
                      </a>
                    </>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
        {view.unchecked ? (
          <span class="text-[12px] text-ink-subtle">
            {uncheckedDependenciesMessage(view.unchecked)}
          </span>
        ) : null}
      </div>
    </Alert>
  );
}
