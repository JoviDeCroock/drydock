import type { BumpEvidence, BumpVerdict, HoldReason, UnreviewedReason } from "./types";

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

export const UNREVIEWED_TEXT: Record<UnreviewedReason, string> = {
  "over-cap": "over the per-PR review limit",
  "not-found": "not found on the public registry",
  unsupported: "Drydock can't diff this version",
  failed: "the diff failed",
  "timed-out": "the diff timed out",
  "private-source": "comes from a registry Drydock can't read",
  "remote-source": "comes from a git, URL, or tarball source Drydock can't diff",
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What a diff left unread, or null when it read everything. */
export function unreadContentText(evidence: BumpEvidence): string | null {
  const parts: string[] = [];
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
 * nothing vouched for (no verdict, a new package, or what the diff left
 * unread), then when the age fallback lets it pass.
 */
export function holdReasonPhrases(
  verdict: Extract<BumpVerdict, { status: "hold" }>,
  options: { newPackage: boolean; formatTime?: (iso: string) => string },
): string[] {
  const formatTime = options.formatTime ?? formatUtcMinute;
  return verdict.reasons.map((reason) => {
    if (reason === "unreviewed" && verdict.unreviewed) {
      return `${HOLD_REASON_TEXT.unreviewed} (${UNREVIEWED_TEXT[verdict.unreviewed]})`;
    }
    if (reason !== "too-new") return HOLD_REASON_TEXT[reason];
    const what = verdict.unreviewed
      ? `${HOLD_REASON_TEXT.unreviewed} (${UNREVIEWED_TEXT[verdict.unreviewed]})`
      : verdict.evidence
        ? unreadContentText(verdict.evidence)
        : options.newPackage
          ? HOLD_REASON_TEXT["new-package"]
          : null;
    const when = verdict.passesAt
      ? `${HOLD_REASON_TEXT["too-new"]}; passes ${formatTime(verdict.passesAt)}`
      : verdict.unreviewed === "remote-source"
        ? "a git, URL, or tarball source has no publish time, so it holds until approved"
        : "its publish time is unknown, so it holds until approved";
    return what ? `${what}; ${when}` : when;
  });
}
