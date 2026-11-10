import { hasCheckablePin } from "./evidence";
import type {
  BumpEvidence,
  BumpVerdict,
  DependencyBump,
  HoldReason,
  NewDependencyCause,
  UnreviewedReason,
} from "./types";

/** The stored bump fields the wording reads. */
type WordedBump = Pick<
  DependencyBump,
  "ecosystem" | "fromVersion" | "repinned" | "mirror" | "pinnedHashes"
>;

// One phrase per reason, read by the check run and the dashboard alike, so a
// reviewer sees the same words on GitHub and in Drydock. Plain text: the check
// run embeds them in markdown and the UI renders them as text.
export const HOLD_REASON_TEXT: Record<HoldReason, string> = {
  "install-script-added": "adds an install script",
  "install-script-changed": "changes an install script",
  "native-binary-added": "adds a native binary",
  "dependency-added": "adds a dependency",
  "bin-command-added": "adds a bin command",
  "release-risk": "release risk at or above the hold threshold",
  "uninspected-files": "changes files or artifacts Drydock could not read",
  unreviewed: "no Drydock verdict",
  "new-package": "new package with no previous version to compare",
  "too-new": "younger than the minimum age for unread updates",
};

const UNREVIEWED_TEXT: Record<UnreviewedReason, string> = {
  "over-cap": "over the per-PR review limit",
  "not-found": "not found on the public registry",
  unsupported: "Drydock can't diff this version",
  failed: "the diff failed",
  "timed-out": "the diff timed out",
  "private-source": "comes from a registry Drydock can't read",
  "remote-source": "comes from a git, URL, or tarball source Drydock can't diff",
  "unverified-pin":
    "Drydock could not match the hashes pinned for this update to the public registry's release",
};

// An `unverified-pin` whose entry pins nothing a lookup can match. No lookup
// ran, so Re-run can never clear it.
const UNPINNED_TEXT =
  "the lockfile pins no hash Drydock can check for this update, so it cannot be tied to the public release";

function isUnpinned(reason: UnreviewedReason | undefined, bump: WordedBump): boolean {
  return (
    reason === "unverified-pin" &&
    (bump.mirror !== undefined || bump.pinnedHashes !== undefined) &&
    !hasCheckablePin(bump)
  );
}

/** Why this bump has no verdict, in the words the check run and dashboard share. */
export function unreviewedText(reason: UnreviewedReason, bump: WordedBump): string {
  return isUnpinned(reason, bump) ? UNPINNED_TEXT : UNREVIEWED_TEXT[reason];
}

// A lockfile that kept a version and changed what it pins for it. Read by the
// check run and the dashboard in place of the new-package wording.
export const REPINNED_TEXT = "same version, new pin";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What a diff left unread, or null when it read everything. */
export function unreadContentText(evidence: BumpEvidence): string | null {
  const parts: string[] = [];
  if (evidence.nativeBinariesAdded > 0) {
    parts.push(
      `adds ${plural(evidence.nativeBinariesAdded, "native binary", "native binaries")} no rule reads`,
    );
  }
  const native = evidence.nativeBinariesChanged ?? 0;
  if (native > 0) {
    parts.push(`changes ${plural(native, "native binary", "native binaries")} no rule reads`);
  }
  if (evidence.uninspectedFiles > 0) {
    parts.push(`${plural(evidence.uninspectedFiles, "file", "files")} Drydock could not read`);
  }
  const notices = evidence.coverageNotices ?? 0;
  if (notices > 0) {
    parts.push(`${plural(notices, "artifact", "artifacts")} the diff did not read`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

/** `2026-11-13 09:30 UTC`: the check run has no reader time zone. */
function formatUtcMinute(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * The phrases for one hold, in reason order. A `too-new` hold first says what
 * nothing vouched for (no verdict, a new package or pin, or what the diff
 * left unread), then when the age fallback lets it pass. A repinned bump
 * kept its version and changed its pin, which reads differently from a
 * package the PR adds.
 */
export function holdReasonPhrases(
  verdict: Extract<BumpVerdict, { status: "hold" }>,
  options: { bump: WordedBump } & PhraseFormat,
): string[] {
  const { bump } = options;
  const formatTime = options.formatTime ?? formatUtcMinute;
  const added = bump.repinned ? REPINNED_TEXT : HOLD_REASON_TEXT["new-package"];
  return verdict.reasons.map((reason) => {
    if (reason === "unreviewed" && verdict.unreviewed) {
      return `${HOLD_REASON_TEXT.unreviewed} (${unreviewedText(verdict.unreviewed, bump)})`;
    }
    if (reason === "new-package") return added;
    if (reason === "dependency-added") return newDependencyText(verdict.newDependency, options);
    if (reason !== "too-new") return HOLD_REASON_TEXT[reason];
    const what = verdict.unreviewed
      ? `${HOLD_REASON_TEXT.unreviewed} (${unreviewedText(verdict.unreviewed, bump)})`
      : verdict.evidence
        ? unreadContentText(verdict.evidence)
        : bump.fromVersion === null
          ? added
          : null;
    const age = ageHoldText(verdict, bump, formatTime);
    return what ? `${what}; ${age}` : age;
  });
}

interface PhraseFormat {
  // The check run fences names as code; the dashboard renders text as is.
  formatName?: (name: string) => string;
  formatTime?: (iso: string) => string;
}

/**
 * The `dependency-added` phrase: which added dependency holds and why. A
 * verdict decided before the cause was recorded reads as before.
 */
export function newDependencyText(
  cause: NewDependencyCause | undefined,
  format: PhraseFormat = {},
): string {
  if (!cause) return HOLD_REASON_TEXT["dependency-added"];
  if (cause.cause === "lockfile-unpinned") {
    return "adds a dependency; this lockfile does not pin transitive dependencies, so Drydock cannot see what it installs";
  }
  if (cause.cause === "unmatched") {
    return "adds a dependency Drydock could not match against the lockfile";
  }
  const name = (format.formatName ?? ((text: string) => text))(cause.name);
  const formatTime = format.formatTime ?? formatUtcMinute;
  const on = `adds a dependency on ${name}, a package new to the lockfile`;
  switch (cause.why) {
    case "first-published":
      return `${on} and first published ${formatTime(cause.at)}`;
    case "version-published":
      return `${on} whose installed version was published ${formatTime(cause.at)}`;
    case "age-unknown":
      return `${on} whose age Drydock could not establish`;
    case "no-verdict":
      return `${on} with no Drydock verdict`;
  }
}

function ageHoldText(
  verdict: Extract<BumpVerdict, { status: "hold" }>,
  bump: WordedBump,
  formatTime: (iso: string) => string,
): string {
  if (verdict.passesAt)
    return `${HOLD_REASON_TEXT["too-new"]}; passes ${formatTime(verdict.passesAt)}`;
  if (verdict.unreviewed === "remote-source") {
    return "a git, URL, or tarball source has no publish time, so it holds until approved";
  }
  if (verdict.unreviewed === "unverified-pin") {
    if (isUnpinned(verdict.unreviewed, bump)) return "it holds until approved";
    const rerun = "it holds until approved; Re-run checks again if the registry was unreachable";
    // Private scopes are an npm setting; there is no PyPI counterpart to name.
    return bump.ecosystem === "npm"
      ? `${rerun}, and an npm package your organization hosts itself belongs under private npm scopes`
      : rerun;
  }
  if (verdict.pastReviewLimit) {
    // An over-cap verdict already names the limit.
    return verdict.unreviewed === "over-cap"
      ? "Drydock did not look up its age, so it holds until approved"
      : "past the per-PR review limit, so Drydock did not look up its age; it holds until approved";
  }
  return "its publish time is unknown, so it holds until approved";
}
