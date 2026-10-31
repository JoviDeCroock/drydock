/**
 * What the decision view says about a release's dependency readiness. Pure so
 * the wording and the "when to say anything" rules are testable apart from
 * the page. A clean check and an inapplicable one both render nothing.
 */
import type {
  DependencyReadinessIssue,
  DependencyReadinessResponse,
} from "../../server/lib/ecosystems/npm/dependency-readiness";
import { canOfferNpmStageFollowUp, type NpmStageFollowUpScan } from "../lib/npm-stage-follow-up";

export interface DependencyReadinessScan extends NpmStageFollowUpScan {
  status?: string | null;
}

/**
 * Only while approving still lies ahead: a staged review whose npm stage is
 * still actionable, or a gate review whose held deployment is still pending.
 */
export function dependencyReadinessApplies(
  scan: DependencyReadinessScan | null | undefined,
  gateStatus: string | null | undefined,
): boolean {
  if (!scan || scan.status !== "complete") return false;
  if (scan.source === "workflow_gate") return gateStatus === "pending";
  if (scan.source !== "manual" && scan.source !== "auto_discovery") return false;
  return canOfferNpmStageFollowUp(scan);
}

export interface DependencyReadinessView {
  /** Dependencies a consumer cannot install yet. */
  blocking: DependencyReadinessIssue[];
  /** Dependencies that could not be checked: a lookup failed or was skipped. */
  unchecked: number;
  /** `warn` when a required dependency is affected; optional and peer alone read as `info`. */
  tone: "warn" | "info";
}

export function dependencyReadinessView(
  response: DependencyReadinessResponse | null,
): DependencyReadinessView | null {
  if (!response || response.status !== "checked") return null;
  const blocking = response.issues.filter((issue) => issue.kind !== "unchecked");
  const unchecked = response.issues.length - blocking.length;
  if (!blocking.length && !unchecked) return null;
  return {
    blocking,
    unchecked,
    tone: blocking.some((issue) => issue.section === "dependencies") ? "warn" : "info",
  };
}

export function dependencySectionLabel(issue: DependencyReadinessIssue): string | null {
  if (issue.section === "optionalDependencies") return "optional";
  if (issue.section === "peerDependencies") return "peer";
  return null;
}

export function dependencyIssueMessage(issue: DependencyReadinessIssue): string {
  const target = issue.target ?? issue.name;
  switch (issue.kind) {
    case "staged": {
      const staged = issue.staged;
      if (!staged) return `${target} is staged in this organization.`;
      const coordinate = `${target}@${staged.version}`;
      if (staged.decision === "no_publish") {
        return `${coordinate} is staged in this organization, and the organization rejected it.`;
      }
      if (staged.decision === "publish") {
        return `${coordinate} is approved here but still staged on npm. Approve it on npm first.`;
      }
      return `${coordinate} is staged in this organization and not published yet. Approve it first.`;
    }
    case "unpublished":
      return issue.packageFound
        ? `No published version of ${target} matches.`
        : `npm does not list ${target}, or this organization's token cannot read it.`;
    case "local-spec":
      return "A local spec. npm cannot install it from the registry; the publish should have replaced it with a version.";
    case "unchecked":
      return "Could not be checked.";
  }
}

export function uncheckedDependenciesMessage(count: number): string {
  return `Could not check ${count} ${count === 1 ? "dependency" : "dependencies"} against npm.`;
}
