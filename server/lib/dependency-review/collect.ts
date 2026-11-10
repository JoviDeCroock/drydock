import { dependencyChangeKey } from "../../db/dependency-reviews";
import { isRecord } from "../platform/guards";
import type { ReviewContext } from "./context";
import {
  fetchMergeBase,
  listPullRequestFiles,
  readRepositoryFile,
  type PullRequestFile,
} from "./github";
import {
  diffLockfileSnapshots,
  lockfileKindForPath,
  parseLockfile,
  unpinnedRequirementsChanged,
} from "./lockfiles";
import { npmManifestHasOnlyMetadataChanges } from "./manifests";
import {
  collectCustomRegistries,
  emptyCustomRegistries,
  isPublicNpmName,
  type CustomRegistries,
} from "./registry-config";
import type { DependencyBump, DependencyEcosystem, LockfileKind } from "./types";

const MAX_LOCKFILES = 20;
const MAX_MANIFESTS = 20;
// npm and PyPI lockfiles Drydock can't parse. A PR that changes one is not
// "nothing to review": it is unread, and holds like any unreviewed bump.
const UNPARSED_LOCKFILE =
  /(?:^|\/)(?:bun\.lockb?|poetry\.lock|Pipfile\.lock|pdm\.lock|pylock(?:\.[^/]+)?\.toml)$/;
// A manifest changed with no parsed lockfile of its
// ecosystem at or above its directory (a library without a lockfile, or a
// Python project in a PR that only touched npm's) names versions nothing here
// resolved.
const NPM_MANIFEST = /(?:^|\/)package\.json$/;
const PYPI_MANIFEST = /(?:^|\/)(?:pyproject\.toml|setup\.cfg|setup\.py|Pipfile|[^/]+\.in)$/;
// pip follows `-r`/`-c` into files of any name. A changed
// `.txt` is read as requirements: anything in it that
// isn't a pin is compared as text, so a file that isn't one holds, not passes.
const OTHER_REQUIREMENTS = /\.txt$/;

const KIND_ECOSYSTEM: Record<LockfileKind, DependencyEcosystem> = {
  npm: "npm",
  pnpm: "npm",
  yarn: "npm",
  uv: "pypi",
  requirements: "pypi",
};

export interface CollectedBumps {
  bumps: DependencyBump[];
  // Lockfiles the PR changes whose bumps are unknown: an unparsed format, over
  // the per-review or size cap, or a snapshot the parser couldn't finish.
  unreadLockfiles: string[];
  listingComplete: boolean;
}

/**
 * The version changes the PR merges, from each supported lockfile read at the
 * merge base and at the head. The merge base, not the base branch tip, is the
 * "before" side, so commits that landed on the base branch after the PR was
 * opened don't read as bumps.
 */
export async function collectBumps(
  context: ReviewContext,
  baseSha: string,
  changedFiles: number | null,
): Promise<CollectedBumps> {
  const { review, repo, token } = context;
  const listing = await listPullRequestFiles(token, repo, review.pullNumber);
  const { files } = listing;
  // GitHub's files listing stops at 3,000 entries without saying so; the PR's
  // own count is what shows the listing was cut short.
  const complete = listing.complete && (changedFiles === null || files.length >= changedFiles);
  const changed = files.filter((file) => file.status !== "removed");
  const lockfiles: Array<{ file: PullRequestFile; kind: LockfileKind }> = [];
  for (const file of changed) {
    if (UNPARSED_LOCKFILE.test(file.filename)) continue;
    const kind =
      lockfileKindForPath(file.filename) ??
      (OTHER_REQUIREMENTS.test(file.filename) ? "requirements" : null);
    if (kind) lockfiles.push({ file, kind });
  }
  const unreadLockfiles: string[] = [
    ...changed.filter((file) => UNPARSED_LOCKFILE.test(file.filename)).map((file) => file.filename),
    ...lockfiles.slice(MAX_LOCKFILES).map(({ file }) => file.filename),
    // A deleted lockfile's packages now resolve from wherever the manifest says.
    ...files
      .filter(
        (file) =>
          file.status === "removed" &&
          (lockfileKindForPath(file.filename) || UNPARSED_LOCKFILE.test(file.filename)),
      )
      .map((file) => file.filename),
  ];
  const heads: HeadLockfile[] = lockfiles.slice(MAX_LOCKFILES).map(({ file, kind }) => ({
    path: file.filename,
    kind,
    text: null,
    manifest: null,
    fallback: !lockfileKindForPath(file.filename),
  }));
  let mergeBasePromise: Promise<string> | undefined;
  const mergeBaseRef = () =>
    (mergeBasePromise ??= fetchMergeBase(token, repo, baseSha, review.headSha));
  if (lockfiles.length === 0) {
    unreadLockfiles.push(...(await unreadManifests(context, changed, heads, mergeBaseRef)));
    return { bumps: [], unreadLockfiles, listingComplete: complete };
  }

  const mergeBase = await mergeBaseRef();
  const registries = new Map<string, Promise<CustomRegistries>>();
  const byChange = new Map<string, DependencyBump>();
  for (const { file, kind } of lockfiles.slice(0, MAX_LOCKFILES)) {
    const fallback = !lockfileKindForPath(file.filename);
    const beforePath = file.status === "added" ? null : (file.previousFilename ?? file.filename);
    const [before, after] = await Promise.all([
      beforePath ? readLockfileText(context, kind, beforePath, mergeBase) : null,
      readLockfileText(context, kind, file.filename, review.headSha),
    ]);
    if (before === "too-large" || after === "too-large" || after === null) {
      unreadLockfiles.push(file.filename);
      heads.push({ path: file.filename, kind, text: null, manifest: null, fallback });
      continue;
    }
    heads.push({ path: file.filename, kind, text: after.text, manifest: after.manifest, fallback });
    const baseSnapshot = before
      ? parseLockfile(kind, before.text, { manifestText: before.manifest })
      : null;
    const headSnapshot = parseLockfile(kind, after.text, { manifestText: after.manifest });
    // A capped or unparseable side diffs to nothing, which must not read as
    // "nothing changed".
    if (!headSnapshot.complete || (baseSnapshot && !baseSnapshot.complete)) {
      unreadLockfiles.push(file.filename);
      continue;
    }
    // A requirements range (`foo>=1.3`) names no version to diff.
    if (unpinnedRequirementsChanged(baseSnapshot, headSnapshot)) {
      unreadLockfiles.push(file.filename);
    }
    let custom: CustomRegistries | null = null;
    if (KIND_ECOSYSTEM[kind] === "npm") {
      const dir = dirname(file.filename);
      if (!registries.has(dir)) registries.set(dir, readCustomRegistries(context, dir));
      custom = await (registries.get(dir) as Promise<CustomRegistries>);
    }
    for (const found of diffLockfileSnapshots(baseSnapshot, headSnapshot, file.filename)) {
      // A name the repository routes to another registry is kept, never
      // diffed: dropping it would let its change pass unseen.
      const bump: DependencyBump =
        custom && !isPublicNpmName(custom, found.name) ? { ...found, privateSource: true } : found;
      const key = dependencyChangeKey(bump);
      const existing = byChange.get(key);
      if (existing) existing.direct ||= bump.direct;
      else byChange.set(key, { ...bump });
    }
  }
  unreadLockfiles.push(...(await unreadManifests(context, changed, heads, mergeBaseRef)));
  // Direct bumps first: when the per-review cap bites, it bites transitive churn.
  const bumps = [...byChange.values()].sort(
    (a, b) => Number(b.direct) - Number(a.direct) || a.name.localeCompare(b.name),
  );
  return { bumps, unreadLockfiles, listingComplete: complete };
}

async function readLockfileText(
  context: ReviewContext,
  kind: LockfileKind,
  path: string,
  ref: string,
): Promise<{ text: string; manifest: string | null } | "too-large" | null> {
  const text = await readRepositoryFile(context.token, context.repo, path, ref);
  if (text === null || text === "too-large") return text;
  if (kind !== "yarn") return { text, manifest: null };
  const manifest = await readRepositoryFile(
    context.token,
    context.repo,
    `${dirname(path)}package.json`,
    ref,
  );
  return { text, manifest: typeof manifest === "string" ? manifest : null };
}

async function readCustomRegistries(
  context: ReviewContext,
  dir: string,
): Promise<CustomRegistries> {
  const found = emptyCustomRegistries();
  for (const base of new Set([dir, ""])) {
    const [npmrc, yarnrc] = await Promise.all([
      readRepositoryFile(context.token, context.repo, `${base}.npmrc`, context.review.headSha),
      readRepositoryFile(context.token, context.repo, `${base}.yarnrc.yml`, context.review.headSha),
    ]);
    // Config too large to read could name any registry, so it drops every name.
    if (npmrc === "too-large" || yarnrc === "too-large") return { all: true, scopes: new Set() };
    collectCustomRegistries(found, { npmrc, yarnrc });
  }
  return found;
}

interface HeadLockfile {
  path: string;
  kind: LockfileKind;
  // Null when the lockfile went unread, which already holds the review.
  text: string | null;
  manifest: string | null;
  // A `.txt` read as requirements without a recognized requirements filename.
  fallback: boolean;
}

async function unreadManifests(
  context: ReviewContext,
  changed: readonly PullRequestFile[],
  heads: readonly HeadLockfile[],
  mergeBaseRef: () => Promise<string>,
): Promise<string[]> {
  const unread: string[] = [];
  let inspected = 0;
  for (const path of uncoveredManifests(changed, heads)) {
    // Bound API reads independently of the lockfile cap. Unread manifests
    // still hold; a large PR cannot turn a capped comparison into a pass.
    if (!NPM_MANIFEST.test(path) || inspected >= MAX_MANIFESTS) {
      unread.push(path);
      continue;
    }
    inspected += 1;
    const file = changed.find((entry) => entry.filename === path)!;
    const [before, after] = await Promise.all([
      // Moving a manifest can change workspace or registry resolution even
      // when its dependency strings match the old directory's manifest.
      file.status === "added" || file.status === "renamed"
        ? "{}"
        : readRepositoryFile(context.token, context.repo, path, await mergeBaseRef()),
      readRepositoryFile(context.token, context.repo, path, context.review.headSha),
    ]);
    if (
      before === null ||
      after === null ||
      before === "too-large" ||
      after === "too-large" ||
      !npmManifestHasOnlyMetadataChanges(before, after)
    ) {
      unread.push(path);
    }
  }
  return unread;
}

/**
 * Changed manifests no changed lockfile resolves. A lockfile covers a manifest
 * in its own directory, or below it only when it records that directory as a
 * workspace: a root lockfile says nothing about a sibling project with none.
 */
function uncoveredManifests(
  changed: readonly PullRequestFile[],
  heads: readonly HeadLockfile[],
): string[] {
  const workspaces = new Map<HeadLockfile, (dir: string) => boolean>();
  const covers = (head: HeadLockfile, manifest: string) => {
    if (head.fallback) return false;
    const manifestDir = dirname(manifest);
    const lockDir = dirname(head.path);
    // A requirements file pins what it lists, not what a pyproject beside it
    // declares, unless it was compiled from that manifest (pip-compile names
    // its sources in the header).
    if (head.kind === "requirements") {
      if (manifestDir !== lockDir) return false;
      const name = manifest.slice(manifestDir.length);
      const pairedIn = name === `${head.path.slice(lockDir.length).replace(/\.txt$/, "")}.in`;
      return pairedIn || compiledFrom(head.text, name);
    }
    if (manifestDir === lockDir) return true;
    if (!manifestDir.startsWith(lockDir)) return false;
    if (head.text === null) return true;
    let isWorkspace = workspaces.get(head);
    if (!isWorkspace) {
      isWorkspace = workspaceMatcher(head.kind, head.text, head.manifest);
      workspaces.set(head, isWorkspace);
    }
    return isWorkspace(manifestDir.slice(lockDir.length, -1));
  };
  const covered = (ecosystem: DependencyEcosystem, manifest: string) =>
    heads.some((head) => KIND_ECOSYSTEM[head.kind] === ecosystem && covers(head, manifest));
  return changed
    .map((file) => file.filename)
    .filter(
      (path) =>
        (NPM_MANIFEST.test(path) && !covered("npm", path)) ||
        (PYPI_MANIFEST.test(path) && !covered("pypi", path)),
    );
}

// pip-compile and `uv pip compile` write their command line into the leading
// comment block, naming the inputs the file was resolved from.
const COMPILE_COMMAND = /^#\s+(?:pip-compile|uv pip compile)\s/;

function compiledFrom(text: string | null, manifestName: string): boolean {
  if (text === null) return true;
  for (const line of text.split("\n", 40)) {
    if (!line.startsWith("#")) break;
    if (COMPILE_COMMAND.test(line) && line.split(/\s+/).includes(manifestName)) return true;
  }
  return false;
}

const PNPM_IMPORTER = /^ {2}(['"]?)(.+?)\1:\s*$/;
const UV_LOCAL_SOURCE = /source = \{ (?:editable|virtual|directory) = "([^"]+)" \}/g;
const BERRY_WORKSPACE = /@workspace:([^"]+)"/g;

/** Which directories, relative to the lockfile's, it records as workspaces. */
function workspaceMatcher(
  kind: LockfileKind,
  text: string,
  manifest: string | null,
): (dir: string) => boolean {
  const dirs = new Set<string>();
  const normalize = (dir: string) => dir.replace(/^\.\//, "").replace(/\/+$/, "");
  if (kind === "npm") {
    const parsed = parseJson(text);
    const packages = isRecord(parsed) && isRecord(parsed.packages) ? parsed.packages : {};
    for (const key of Object.keys(packages)) {
      if (key && !key.includes("node_modules/")) dirs.add(key);
    }
  } else if (kind === "pnpm") {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => line.trimEnd() === "importers:");
    for (let index = start + 1; start >= 0 && index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\S/.test(line)) break;
      const match = PNPM_IMPORTER.exec(line);
      if (match) dirs.add(normalize(match[2]));
    }
  } else if (kind === "uv") {
    for (const match of text.matchAll(UV_LOCAL_SOURCE)) dirs.add(normalize(match[1]));
  } else if (kind === "yarn") {
    for (const match of text.matchAll(BERRY_WORKSPACE)) dirs.add(normalize(match[1]));
    const globs = yarnWorkspaceGlobs(manifest);
    return (dir) => dirs.has(dir) || (dir.length <= 512 && globs.some((glob) => glob.test(dir)));
  }
  return (dir) => dirs.has(dir);
}

// Yarn v1 lockfiles don't list workspaces; the root manifest's globs do. One
// `*` per segment and one `**` keep matching linear in the path.
function yarnWorkspaceGlobs(manifest: string | null): RegExp[] {
  const parsed = manifest ? parseJson(manifest) : null;
  const field = isRecord(parsed) ? parsed.workspaces : null;
  const list = Array.isArray(field) ? field : isRecord(field) ? field.packages : null;
  if (!Array.isArray(list)) return [];
  const globs: RegExp[] = [];
  for (const glob of list.slice(0, 100)) {
    if (typeof glob !== "string" || glob.length > 200) continue;
    const parts = glob.replace(/^\.\//, "").replace(/\/+$/, "").split("/");
    const doubleStars = parts.filter((part) => part === "**").length;
    if (
      doubleStars > 1 ||
      parts.some((part) => (part.match(/\*/g)?.length ?? 0) > 1 && part !== "**")
    ) {
      continue;
    }
    const pattern = parts
      .map((part) => (part === "**" ? ".*" : escapeRegExp(part).replace("\\*", "[^/]*")))
      .join("/");
    globs.push(new RegExp(`^${pattern}$`));
  }
  return globs;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dirname(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
}
