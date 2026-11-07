/**
 * Best-effort bookkeeping for a member loading a completed review's report.
 * Runs after the response (the caller hands it to `waitUntil`), never throws,
 * and never delays or fails the read it describes.
 */
import type { AppDb } from "../../db/client";
import type { ReportViewSurface } from "../../db/enums";
import { recordScanReportView } from "../../db/scans";
import { recordProductEvent } from "../analytics";
import { describeOperationalError, emitOperationalEvent } from "../platform/observability";
import { scanEcosystem } from "../public-feed";

interface ViewedScan {
  id: string;
  organizationId: string | null;
  source: string;
  status: string;
  summaryJson: unknown;
  decision: string | null;
  completedAt: Date | null;
  registryVersionStatus: string | null;
  registryStatusSupersededAt: Date | null;
}

/** Only a landing from an email or Slack link says so; everything else is the web app. */
export function reportViewSurface(via: string | undefined): ReportViewSurface {
  return via === "notification" ? "notification" : "web";
}

export async function recordReportView(
  env: Pick<Cloudflare.Env, "PRODUCT_ANALYTICS">,
  db: AppDb,
  scan: ViewedScan,
  surface: ReportViewSurface,
  now = new Date(),
): Promise<void> {
  if (scan.status !== "complete" || !scan.organizationId) return;
  try {
    const { firstView } = await recordScanReportView(db, {
      scanId: scan.id,
      organizationId: scan.organizationId,
      surface,
      now,
    });
    if (!firstView) return;
    recordProductEvent(env, {
      name: "scan.viewed",
      organizationId: scan.organizationId,
      ecosystem: scanEcosystem(scan.source, scan.summaryJson) ?? "",
      source: scan.source,
      surface,
      registryStatus: scan.registryStatusSupersededAt
        ? "superseded"
        : (scan.registryVersionStatus ?? "none"),
      decided: scan.decision ? "decided" : "undecided",
      sinceCompletionMs: scan.completedAt
        ? Math.max(0, now.getTime() - scan.completedAt.getTime())
        : 0,
    });
  } catch (err) {
    emitOperationalEvent("warn", "scan.report_view_record_failed", {
      organizationId: scan.organizationId,
      scanId: scan.id,
      error: describeOperationalError(err),
    });
  }
}
