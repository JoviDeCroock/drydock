import { Alert } from "../../components/Alert";
import type { PublicationWatch } from "../../models/publication-watches";
import { coverageGapMessage } from "./copy";

/**
 * A persistent coverage gap on a watch, shared by the dashboard card and the
 * package page. It is told apart from a discrepancy (nothing was found wrong)
 * and from a passing problem (shown as the watch's last problem instead).
 */
export function CoverageGap({ watch }: { watch: PublicationWatch }) {
  const message = coverageGapMessage(watch);
  if (!message) return null;
  return (
    <div class="px-5 pb-3.5">
      <Alert tone="warn">{message}</Alert>
    </div>
  );
}
