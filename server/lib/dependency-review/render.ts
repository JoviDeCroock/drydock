import type {
  BumpEvidence,
  DependencyBump,
  DependencyReviewConclusion,
  ReviewedBump,
} from "./types";
import { hasUnreadContent } from "./evidence";
import { holdReasonPhrases, unreadContentText, UNREVIEWED_TEXT } from "./wording";

export const DEPENDENCY_REVIEW_CHECK_NAME = "Drydock dependency review";
export const APPROVE_ACTION_IDENTIFIER = "approve-holds";
// The `external_id` of a skipped run, so a review knows it may publish over one.
export const SKIP_EXTERNAL_ID_PREFIX = "skip:";

// GitHub rejects a check-run output field over 65,535 characters.
const MAX_SUMMARY_CHARS = 60_000;
const MAX_LISTED_BUMPS = 100;
// Bounds what a review stores, holds first; the summary's truncation note names it.
export const MAX_STORED_BUMPS = 500;
// The held section renders first; this leaves room for the lines around it.
const HELD_SECTION_BUDGET = MAX_SUMMARY_CHARS - 1_000;
const MAX_FINDINGS_PER_BUMP = 3;

export interface CheckRunOutput {
  title: string;
  summary: string;
}

export interface RenderDependencyReviewInput {
  bumps: readonly ReviewedBump[];
  conclusion: DependencyReviewConclusion;
  // Absolute /diff link for a bump, or null when the origin is unknown.
  diffUrl: (bump: DependencyBump) => string | null;
  approvedBy: string | null;
  // Lockfiles the PR changes whose bumps Drydock couldn't read.
  unreadLockfiles: readonly string[];
  // False when GitHub listed only part of the PR's files.
  listingComplete?: boolean;
  // False when the check can't show every hold (`listsEveryHold`): no Approve.
  approvable?: boolean;
}

function openHolds(bumps: readonly ReviewedBump[]): ReviewedBump[] {
  return bumps.filter((b) => b.verdict.status === "hold" && !b.approved);
}

/**
 * Whether the check run shows every open hold in full. Approve accepts all of
 * them, so it is only offered when nobody could approve a hold they weren't
 * shown.
 */
export function listsEveryHold(input: RenderDependencyReviewInput): boolean {
  const held = openHolds(input.bumps);
  if (
    input.listingComplete === false ||
    held.length > MAX_LISTED_BUMPS ||
    input.unreadLockfiles.length > MAX_LISTED_BUMPS
  ) {
    return false;
  }
  let length = (renderUnread(input)?.length ?? 0) + 1;
  for (const bump of held) {
    for (const line of renderHeld(bump, input)) length += line.length + 1;
  }
  return length <= HELD_SECTION_BUDGET;
}

/**
 * Check-run output for one dependency review. Package names, versions, file
 * paths, rule ids, and finding reasons all describe packages someone else
 * published, so each renders inside a code span, which GitHub never turns into
 * links, mentions, images, or HTML.
 */
export function renderDependencyReviewCheck(input: RenderDependencyReviewInput): CheckRunOutput {
  const held = openHolds(input.bumps);
  const approved = input.bumps.filter((b) => b.verdict.status === "hold" && b.approved);
  // A diff that left content unread passed under policy; it is not "clear".
  const unread = input.bumps.filter(isPassedUnread);
  const clear = input.bumps.filter((b) => b.verdict.status === "clear" && !isPassedUnread(b));
  const unreviewed = input.bumps.filter((b) => b.verdict.status === "unreviewed");
  const added = input.bumps.filter((b) => b.verdict.status === "new-package" && !b.bump.repinned);
  const repinned = input.bumps.filter((b) => b.verdict.status === "new-package" && b.bump.repinned);
  const complete = input.unreadLockfiles.length === 0 && input.listingComplete !== false;

  const lines: string[] = [];
  if (input.bumps.length === 0 && complete) {
    lines.push(
      "This PR adds no npm or PyPI dependencies and changes no resolved npm or PyPI package versions. Other ecosystems are not reviewed.",
    );
  }
  if (held.length > 0) {
    lines.push(
      `### Held for review (${held.length})`,
      "",
      input.approvable === false
        ? "This check can't show everything held in this PR, so it can't be approved here. Split it into smaller PRs."
        : `Approve below once you've read the diffs. Anyone with write access to this repository can approve.${input.unreadLockfiles.length > 0 ? " Approving also accepts the unread files below." : ""}`,
      "",
    );
    for (const bump of held.slice(0, MAX_LISTED_BUMPS)) lines.push(...renderHeld(bump, input));
    lines.push("");
  }
  // Next to the holds: an Approve accepts these too, so they must not be cut.
  const unreadFiles = renderUnread(input);
  if (unreadFiles) lines.push(unreadFiles, "");
  // Held on coverage alone: say what Approve would accept, or why it can't.
  if (input.conclusion === "held" && held.length === 0) {
    lines.push(
      input.approvable === false
        ? "This check can't show every changed file, so it can't be approved here. Split it into smaller PRs."
        : "Approve below to accept these changes unread, or change the files so Drydock can read them. Anyone with write access to this repository can approve.",
      "",
    );
  }
  if (approved.length > 0) {
    const by = input.approvedBy ? ` by ${code(input.approvedBy, 39)}` : "";
    lines.push(`### Approved${by} (${approved.length})`, "");
    for (const bump of approved.slice(0, MAX_LISTED_BUMPS)) lines.push(...renderHeld(bump, input));
    lines.push("");
  }
  if (unreviewed.length > 0) {
    lines.push(`### Not reviewed (${unreviewed.length})`, "");
    for (const bump of unreviewed.slice(0, MAX_LISTED_BUMPS)) {
      const reason =
        bump.verdict.status === "unreviewed" ? UNREVIEWED_TEXT[bump.verdict.unreviewed] : "";
      lines.push(`- ${link(bump.bump, input)}: ${reason}`);
    }
    lines.push("");
  }
  if (added.length > 0) {
    lines.push(`### New packages (${added.length})`, "");
    lines.push(listLine(added, input), "");
  }
  if (repinned.length > 0) {
    // Proven to be the public release's bytes; there is no earlier version to diff.
    lines.push(`### Same version, new pin (${repinned.length})`, "");
    lines.push(listLine(repinned, input), "");
  }
  if (unread.length > 0) {
    lines.push(`### Passed with unread changes (${unread.length})`, "");
    for (const bump of unread.slice(0, MAX_LISTED_BUMPS)) {
      const what =
        bump.verdict.status === "clear" ? unreadContentText(bump.verdict.evidence) : null;
      lines.push(`- ${link(bump.bump, input)}: ${what ?? ""}`);
    }
    lines.push("");
  }
  if (clear.length > 0) {
    lines.push(`### Clear (${clear.length})`, "");
    lines.push(listLine(clear, input), "");
  }

  return {
    title: renderTitle(input.conclusion, held.length, input.bumps.length, clear.length, complete),
    summary: bound(lines),
  };
}

function renderUnread(input: RenderDependencyReviewInput): string | null {
  if (input.unreadLockfiles.length === 0) return null;
  const paths = input.unreadLockfiles.slice(0, MAX_LISTED_BUMPS).map((path) => code(path, 120));
  // Lockfiles, manifests, or registry config: whatever changed there is unreviewed.
  return `Drydock couldn't review the changes to ${paths.join(", ")}, so the dependency updates ${input.unreadLockfiles.length === 1 ? "it makes" : "they make"} are not reviewed.`;
}

function renderTitle(
  conclusion: DependencyReviewConclusion,
  heldCount: number,
  total: number,
  clearCount: number,
  complete: boolean,
): string {
  if (conclusion === "held") {
    // Held with nothing held per bump: a lockfile or the file listing went unread.
    if (heldCount === 0) return "Held: some updates could not be read";
    return `${heldCount} of ${total} ${total === 1 ? "update" : "updates"} held for review`;
  }
  if (conclusion === "approved") return "Held updates approved";
  if (total === 0 && complete) return "No npm or PyPI dependency updates";
  // "Clear" claims every diff was read in full; unreviewed bumps, new
  // packages, and diffs with unread changes passing by policy were not.
  if (!complete || clearCount < total) return "No updates held";
  return `${total === 1 ? "Update" : `All ${total} updates`} clear`;
}

/** A bump policy let pass on a diff that left part of the release unread. */
function isPassedUnread(bump: ReviewedBump): boolean {
  return bump.verdict.status === "clear" && hasUnreadContent(bump.verdict.evidence);
}

function renderHeld(reviewed: ReviewedBump, input: RenderDependencyReviewInput): string[] {
  const { verdict } = reviewed;
  if (verdict.status !== "hold") return [];
  const reasons = holdReasonPhrases(verdict, {
    newPackage: reviewed.bump.fromVersion === null,
    repinned: reviewed.bump.repinned === true,
  });
  const lines = [`- ${link(reviewed.bump, input)}: ${reasons.join("; ")}`];
  if (verdict.evidence) lines.push(...renderEvidence(verdict.evidence));
  return lines;
}

function renderEvidence(evidence: BumpEvidence): string[] {
  const lines = [
    `  - Release risk **${evidence.releaseRisk}**, ${evidence.filesAdded} added, ${evidence.filesRemoved} removed, ${evidence.filesChanged} changed`,
  ];
  for (const finding of evidence.findings.slice(0, MAX_FINDINGS_PER_BUMP)) {
    const rule = finding.ruleId ? code(finding.ruleId, 80) : "unnamed rule";
    lines.push(
      `  - ${finding.severity}: ${rule} in ${code(finding.file, 120)}: ${code(finding.reason, 200)}`,
    );
  }
  const more = evidence.findingCount - MAX_FINDINGS_PER_BUMP;
  if (more > 0)
    lines.push(`  - ${more} more release ${more === 1 ? "finding" : "findings"} in the diff`);
  return lines;
}

function listLine(bumps: readonly ReviewedBump[], input: RenderDependencyReviewInput): string {
  const shown = bumps.slice(0, MAX_LISTED_BUMPS).map((b) => link(b.bump, input));
  const more = bumps.length - shown.length;
  return shown.join(", ") + (more > 0 ? `, and ${more} more` : "");
}

function link(bump: DependencyBump, input: RenderDependencyReviewInput): string {
  const scope = bump.direct ? "" : " (transitive)";
  const range = bump.fromVersion
    ? `${code(bump.name, 214)} ${code(bump.fromVersion, 64)} → ${code(bump.toVersion, 64)}`
    : `${code(bump.name, 214)} ${code(bump.toVersion, 64)}`;
  const url = bump.fromVersion ? input.diffUrl(bump) : null;
  return url ? `[${range}](${url})${scope}` : `${range}${scope}`;
}

function bound(lines: string[]): string {
  let out = "";
  for (const line of lines) {
    if (out.length + line.length + 1 > MAX_SUMMARY_CHARS) {
      return `${out}\n…output truncated; the Drydock review lists up to ${MAX_STORED_BUMPS} updates, open holds first.`;
    }
    out += `${line}\n`;
  }
  return out.trimEnd();
}

// eslint-disable-next-line no-control-regex -- stripping C0/C1 is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
// Soft hyphen, Hangul fillers, BOM, zero-width, line/paragraph separators, and
// bidi embeddings, overrides, and isolates.
const INVISIBLE_CHARS =
  /[\u00ad\u115f\u1160\ufeff\uffa0\u200b-\u200f\u2028-\u202e\u2060-\u2069\u3164]/g;

/**
 * Inline code for untrusted text. Control, bidi, and zero-width characters
 * collapse to spaces so nothing reorders or hides what the reader sees, and
 * the fence is longer than any backtick run inside it.
 */
export function code(value: string, max: number): string {
  let text = value
    .replace(CONTROL_CHARS, " ")
    .replace(INVISIBLE_CHARS, " ")
    .replace(/\u034f/g, " ")
    .replace(/[\u{e0000}-\u{e007f}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...text];
  if (chars.length > max) text = `${chars.slice(0, max - 1).join("")}…`;
  if (!text) return "`-`";
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}
