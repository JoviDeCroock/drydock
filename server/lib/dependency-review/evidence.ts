import type { BumpEvidence, DependencyBump } from "./types";

/**
 * Whether the bump's pin (its mirror hashes, or `pinnedHashes`) names at least
 * one hash a registry lookup can match on every side it pins. False for an
 * entry whose format should pin and doesn't: no lookup can prove it, so the
 * review stage fails its proof without one and the wording does not offer a
 * Re-run.
 */
export function hasCheckablePin(bump: Pick<DependencyBump, "mirror" | "pinnedHashes">): boolean {
  const hashes = bump.mirror ? bump.mirror.toHashes : bump.pinnedHashes;
  return (
    (hashes?.length ?? 0) > 0 && (!bump.mirror?.fromHashes || bump.mirror.fromHashes.length > 0)
  );
}

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
