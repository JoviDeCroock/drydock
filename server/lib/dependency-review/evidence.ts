import type { BumpEvidence } from "./types";

/**
 * Whether the diff left part of the release unread: native binaries it adds
 * or changes (no rule reads machine code, so a new or swapped `.node` would
 * otherwise pass as clear), files no rule read, or artifacts the diff itself
 * reported skipping. `nativeAddedHeld`: the policy already holds an added
 * native binary as a capability, so it is not also unread content. `?? 0`:
 * evidence stored before a field existed lacks it. Kept free of the rule
 * engine so the dashboard can import it.
 */
export function hasUnreadContent(
  evidence: BumpEvidence,
  options: { nativeAddedHeld?: boolean } = {},
): boolean {
  return (
    (!options.nativeAddedHeld && evidence.nativeBinariesAdded > 0) ||
    (evidence.nativeBinariesChanged ?? 0) > 0 ||
    evidence.uninspectedFiles > 0 ||
    (evidence.coverageNotices ?? 0) > 0
  );
}
