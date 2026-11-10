import { createHash } from "node:crypto";
import type { DependencyBump } from "./types";

type IdentityFields = Pick<
  DependencyBump,
  | "ecosystem"
  | "name"
  | "fromVersion"
  | "toVersion"
  | "privateSource"
  | "remoteSource"
  | "mirror"
  | "pinnedHashes"
>;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Where a change's bytes come from, as collection, stored progress, and
 * approvals all key it. A pin nobody has proven equal to the public release
 * names its hashes: the same versions pinned to other bytes are a different
 * change, so they are never merged, never share a stored proof, and never
 * inherit an approval. The review stage strips `mirror` or `pinnedHashes`
 * once a proof succeeds, so a proven bump keys as `public`.
 */
export function changeSource(
  bump: Omit<IdentityFields, "ecosystem" | "name" | "fromVersion" | "toVersion">,
): string {
  if (bump.mirror) {
    return `mirror:${digest([[...(bump.mirror.fromHashes ?? [])].sort(), [...bump.mirror.toHashes].sort()])}`;
  }
  if (bump.pinnedHashes) return `pin:${digest([...bump.pinnedHashes].sort())}`;
  if (bump.remoteSource) return "remote";
  if (bump.privateSource) return "private";
  return "public";
}

export function changeKey(
  ecosystem: string,
  name: string,
  fromVersion: string,
  toVersion: string,
  source: string,
): string {
  return [ecosystem, name, fromVersion, toVersion, source].join("\u0000");
}

/** One change's identity: package, versions, and `changeSource`. */
export function bumpIdentityKey(bump: IdentityFields): string {
  return changeKey(
    bump.ecosystem,
    bump.name,
    bump.fromVersion ?? "",
    bump.toVersion,
    changeSource(bump),
  );
}
