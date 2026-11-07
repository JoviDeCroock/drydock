/**
 * What the decision view says about a release's dependency readiness. Pure so
 * the wording and the "when to say anything" rules are testable apart from
 * the page. A clean check and an inapplicable one both render nothing.
 */
import type {
  DependencyReadinessIssue,
  DependencyReadinessResponse,
} from "../../server/lib/ecosystems/npm/dependency-readiness";
import { scanEcosystem } from "../../server/lib/public-feed";
import { canOfferNpmStageFollowUp, type NpmStageFollowUpScan } from "../lib/npm-stage-follow-up";

export interface DependencyReadinessScan extends NpmStageFollowUpScan {
  status?: string | null;
  summaryJson?: unknown;
}

/**
 * Only for an npm release while approving still lies ahead: a staged review
 * whose npm stage is still actionable, or an npm gate review whose held
 * deployment is still pending. Mirrors the endpoint's own eligibility, so a
 * PyPI gate never asks.
 */
export function dependencyReadinessApplies(
  scan: DependencyReadinessScan | null | undefined,
  gateStatus: string | null | undefined,
): boolean {
  if (!scan || scan.status !== "complete") return false;
  if (scanEcosystem(scan.source ?? "", scan.summaryJson) !== "npm") return false;
  if (scan.source === "workflow_gate") return gateStatus === "pending";
  if (scan.source !== "manual" && scan.source !== "auto_discovery") return false;
  return canOfferNpmStageFollowUp(scan);
}

export interface DependencyReadinessView {
  /** Dependencies a consumer cannot install yet. */
  blocking: DependencyReadinessIssue[];
  /** Registry reads that failed; "Check again" may answer them. */
  failed: number;
  /** Not reached by this check's read budget; the next check reaches them. */
  skipped: number;
  /** Never checked here: an unsupported spec, a registry document too large to read, or past the limit. */
  uncheckable: number;
  /** `warn` when a required dependency is affected; optional and peer alone read as `info`. */
  tone: "warn" | "info";
  /** False when the registry was read anonymously (a gate review without an npm connection). */
  credentialed: boolean;
}

export function dependencyReadinessView(
  response: DependencyReadinessResponse | null,
): DependencyReadinessView | null {
  if (!response || response.status !== "checked") return null;
  const blocking = response.issues.filter((issue) => issue.kind !== "unchecked");
  const count = (reason: string) =>
    response.issues.filter((issue) => issue.kind === "unchecked" && issue.reason === reason).length;
  const failed = count("lookup-failed");
  const skipped = count("lookup-skipped");
  const uncheckable = response.issues.length - blocking.length - failed - skipped;
  if (!blocking.length && !failed && !skipped && !uncheckable) return null;
  return {
    blocking,
    failed,
    skipped,
    uncheckable,
    tone: blocking.some((issue) => issue.section === "dependencies") ? "warn" : "info",
    credentialed: response.credentialed,
  };
}

/**
 * The re-check action, labeled by what it would do. A blocking notice always
 * offers it (the answer moves once a sibling stage is approved); otherwise
 * only a failure or a skipped batch gives it something to do, and a check
 * left with only uncheckable specs offers nothing.
 */
export function dependencyRecheckLabel(view: DependencyReadinessView): string | null {
  if (view.failed || view.blocking.length) return "Check again";
  if (view.skipped) return "Check the rest";
  return null;
}

/** One muted line per kind of dependency the check did not answer. */
export function uncheckedDependencyLines(view: DependencyReadinessView): string[] {
  const noun = (count: number) => (count === 1 ? "dependency" : "dependencies");
  const lines: string[] = [];
  if (view.failed) lines.push(`Could not check ${view.failed} ${noun(view.failed)} against npm.`);
  if (view.skipped) {
    lines.push(
      `${view.skipped} more ${noun(view.skipped)} not checked yet; each check reads a limited number from npm.`,
    );
  }
  if (view.uncheckable) {
    lines.push(
      `${view.uncheckable} ${noun(view.uncheckable)} cannot be checked here: an unsupported spec, a registry document too large to read, or past the check’s limit.`,
    );
  }
  return lines;
}

/**
 * A check that could not run at all says so in one muted line, so it does not
 * read like a clean result. `null` for a response that ran or does not apply.
 */
export function dependencyReadinessUnavailableMessage(
  response: DependencyReadinessResponse | null,
): string | null {
  if (response?.status !== "unavailable") return null;
  switch (response.reason) {
    case "report-unavailable":
      return "Could not check this release’s dependencies: its saved report is unavailable.";
    case "npm-connection-changed":
      return "Could not check this release’s dependencies: the npm connection now points at a different registry than this release was staged on.";
    case "npm-connection-unavailable":
      return "Could not check this release’s dependencies: the organization’s npm connection is missing or not validated.";
  }
}

export function dependencySectionLabel(issue: DependencyReadinessIssue): string | null {
  if (issue.section === "optionalDependencies") return "optional";
  if (issue.section === "peerDependencies") return "peer";
  return null;
}

export function dependencyIssueMessage(
  issue: DependencyReadinessIssue,
  options: { credentialed?: boolean } = {},
): string {
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
      if (issue.packageFound) return `No published version of ${target} matches.`;
      // An anonymous read cannot see a private package consumers may have access to.
      return options.credentialed === false
        ? `npm does not list ${target} publicly. If it is private, consumers need access to it.`
        : `npm does not list ${target}, or this organization's token cannot read it.`;
    case "local-spec":
      return "A local spec. npm cannot install it from the registry; the publish should have replaced it with a version.";
    case "unchecked":
      return "Could not be checked.";
  }
}

/**
 * The notice's headline and consequence. npm installs a release without an
 * optional dependency it cannot resolve, so only a required dependency makes
 * the release fail to install.
 */
export function dependencyReadinessHeadline(view: DependencyReadinessView): {
  title: string;
  consequence: string;
} {
  const count = view.blocking.length;
  const noun = count === 1 ? "dependency" : "dependencies";
  if (view.tone === "warn") {
    return {
      title: `${count} ${noun} cannot be installed from npm yet.`,
      consequence: "Approved now, this release would fail to install for its users.",
    };
  }
  return {
    title: `${count} optional or peer ${noun} cannot be resolved from npm yet.`,
    consequence:
      "npm installs this release without an optional dependency it cannot resolve; a peer the consumer does not already provide fails the install.",
  };
}
