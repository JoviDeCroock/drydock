import { useComputed, useModel } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { useEffect } from "preact/hooks";
import { useLocation } from "preact-iso";
import { Alert } from "../../components/Alert";
import { Button } from "../../components/Button";
import { OrganizationModel } from "../../models/organization";
import { PublishedReviewModel } from "../../models/published-review";
import type { DiffSpec } from "../../lib/package-diff-path";

/**
 * Keep an anonymous diff as an organization's own review.
 *
 * `/diff` is deterministic-only and persists nothing, which is right for a
 * link anyone can open. A signed-in reader is usually one step from wanting the
 * rest — AI review, a recorded decision, a share link — so this runs the same
 * pair through the authenticated pipeline instead of asking them to retype it
 * on the dashboard.
 *
 * Rendered only for a session: the anonymous surface gains nothing, and the
 * organization lookup this needs is an authenticated request. It sits in the
 * page header as a quiet utility beside the package name; what saving adds is
 * the button's description rather than a paragraph competing with the diff.
 */
export function SaveReviewAction({ spec }: { spec: DiffSpec }) {
  const location = useLocation();
  const organizations = useModel(OrganizationModel);
  const review = useModel(PublishedReviewModel);

  useEffect(() => {
    void organizations.load();
  }, []);

  const label = useComputed(() => {
    const name = organizations.active.value?.name;
    return name ? `Save this review to ${name}` : "Save this review";
  });

  const save = async () => {
    const scanId = await review.start(spec.ecosystem, {
      packageName: spec.packageName,
      version: spec.toVersion,
      baselineVersion: spec.fromVersion,
    });
    if (scanId) location.route(`/dashboard/scans/${encodeURIComponent(scanId)}`);
  };

  return (
    <div class="flex flex-col gap-2 items-start sm:items-end">
      <Button
        variant="secondary"
        size="sm"
        disabled={review.busy}
        onClick={() => void save()}
        title="Runs the same pair through the full review — AI review included — and keeps the report with a decision you can record."
      >
        <Show when={review.busy} fallback={label}>
          Starting review…
        </Show>
      </Button>
      <Show when={review.error}>{(message) => <Alert tone="critical">{message}</Alert>}</Show>
    </div>
  );
}
