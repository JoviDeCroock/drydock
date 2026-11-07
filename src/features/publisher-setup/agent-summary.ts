import type { PublisherSetupStatus } from "../../../server/lib/github-app/setup-types";

/**
 * Plain-text copy of the setup checks for a maintainer to paste into a coding
 * agent. The setup-agent prompts on /agents ask for exactly this, because
 * Drydock has no agent-callable setup API: the session-bound checks reach the
 * agent only through the maintainer.
 *
 * The closing line is derived from the status booleans, not check labels. A
 * completed first review proves a gate scan finished, not that it was a real
 * release or that it was approved, so the summary never declares setup done.
 */
export function setupStatusAgentSummary(status: PublisherSetupStatus): string {
  const configured =
    status.targetMapped &&
    status.environmentExists &&
    status.protectionEnabled &&
    status.administratorsCanBypass === false;
  const reviewed = status.firstReview?.scanStatus === "complete";
  const passed = status.checks.filter((check) => check.status === "passed").length;
  const outcome = !configured
    ? "Not ready: a configuration check above is pending or unknown. Do not describe the release as protected."
    : reviewed
      ? "Configuration checks pass and a workflow-gated release completed review. Confirm it was a real release, not a test run, before calling setup complete."
      : "Configuration checks pass. Report setup as ready, pending first release, until a real release completes review.";
  return [
    `Drydock setup checks for ${status.repositoryFullName}, environment ${status.environment}`,
    `${passed} of ${status.checks.length} passed.`,
    "",
    ...status.checks.map((check) => `- ${check.label}: ${check.status}. ${check.detail}`),
    "",
    outcome,
  ].join("\n");
}
