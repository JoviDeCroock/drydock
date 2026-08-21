export const PUBLIC_REPORT_POLL_INTERVAL_MS = 10_000;

export function publicReportPollDelay(report: {
  aiReview?: { status?: unknown } | null;
}): number | null {
  return report.aiReview?.status === "pending" ? PUBLIC_REPORT_POLL_INTERVAL_MS : null;
}
