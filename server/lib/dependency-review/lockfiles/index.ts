import type { LockfileKind } from "../types";
import { parseNpmLock } from "./npm-lock";
import { parsePnpmLock } from "./pnpm-lock";
import { parseRequirements, parseUvLock } from "./python";
import { incompleteSnapshot, MAX_LOCKFILE_CHARS, type LockfileSnapshot } from "./snapshot";
import { parseYarnLock } from "./yarn-lock";

// A TypeScript port of the lockfile readers in
// .github/workflows/drydock-diff-link.yml, extended from direct dependencies to
// every installed package. The workflow keeps its own copy: it runs as a
// self-contained github-script step.
//
// Lockfile bytes are repository data, parsed as data only. Nothing here
// throws on hostile input; unreadable text yields an incomplete snapshot, and
// every name and version is validated before it leaves this module. Private
// registries configured in `.npmrc` / `.yarnrc.yml` are not visible from the
// lockfile, so callers still filter names against that config.

export { diffLockfileSnapshots } from "./diff";

// Whether the requirement lines that name no version changed. A new file
// with any such line counts as changed.
export function unpinnedRequirementsChanged(
  base: LockfileSnapshot | null,
  head: LockfileSnapshot,
): boolean {
  const before = base?.unpinned ?? [];
  return (
    before.length !== head.unpinned.length || before.some((line, i) => line !== head.unpinned[i])
  );
}
export { MAX_LOCKFILE_CHARS, type LockfilePackage, type LockfileSnapshot } from "./snapshot";

const LOCKFILE_PATHS: Array<[RegExp, LockfileKind]> = [
  [/(?:^|\/)(?:package-lock|npm-shrinkwrap)\.json$/, "npm"],
  [/(?:^|\/)pnpm-lock\.yaml$/, "pnpm"],
  [/(?:^|\/)yarn\.lock$/, "yarn"],
  [/(?:^|\/)uv\.lock$/, "uv"],
  // Renovate's default pip_requirements file match with the suffix widened to
  // any `[-._][\w-]+` run (`requirements-dev-py3.txt`), plus constraints files
  // and anything under a requirements/ directory. The suffix is written so
  // only `.` splits it: `(?:[-._][\w-]+)*` backtracks exponentially on a
  // long hostile file name.
  [/(?:^|\/)[\w-]*requirements(?:[-._][\w-]+(?:\.[\w-]+)*)?\.(?:txt|pip)$/, "requirements"],
  [/(?:^|\/)constraints(?:[-._][\w-]+(?:\.[\w-]+)*)?\.txt$/, "requirements"],
  [/(?:^|\/)requirements\/[^/]+\.txt$/, "requirements"],
];

export function lockfileKindForPath(path: string): LockfileKind | null {
  return LOCKFILE_PATHS.find(([pattern]) => pattern.test(path))?.[1] ?? null;
}

const PARSERS: Record<
  LockfileKind,
  (text: string, manifestText: string | null) => LockfileSnapshot
> = {
  npm: parseNpmLock,
  pnpm: parsePnpmLock,
  yarn: parseYarnLock,
  uv: parseUvLock,
  requirements: parseRequirements,
};

// `manifestText` is the package.json beside a yarn.lock, which names the
// root's direct dependencies; the other formats record directness themselves.
export function parseLockfile(
  kind: LockfileKind,
  text: string,
  options: { manifestText?: string | null } = {},
): LockfileSnapshot {
  if (typeof text !== "string" || text.length > MAX_LOCKFILE_CHARS) return incompleteSnapshot();
  const manifestText =
    typeof options.manifestText === "string" && options.manifestText.length <= MAX_LOCKFILE_CHARS
      ? options.manifestText
      : null;
  try {
    return PARSERS[kind](text, manifestText);
  } catch {
    // The parsers handle malformed input themselves; this only keeps an
    // unforeseen failure from escaping as an exception that quotes file text.
    return incompleteSnapshot();
  }
}
