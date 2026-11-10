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
  diffLockfileChanges,
  lockfileKindForPath,
  mergeBump,
  parseLockfile,
  PUBLIC_ROUTE,
  routedBump,
  unpinnedRequirementsChanged,
} from "./lockfiles";
import { npmManifestHasOnlyMetadataChanges } from "./manifests";
import {
  addRouting,
  emptyCustomRegistries,
  npmNameRoute,
  configAncestors,
  committedInstallInput,
  parseRoutingConfig,
  yarnrcCacheFolder,
  resolutionConfigChanged,
  resolutionConfigKind,
  unreadableCustomRegistries,
  type CustomRegistries,
} from "./registry-config";
import { collectionPolicy, type CollectionPolicy } from "./policy";
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
// Resolution config files read per review, beyond which a changed one is
// unread without being compared.
const MAX_CONFIG_FILES = 20;

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
  policy: CollectionPolicy,
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
    workspaces: null,
    fallback: !lockfileKindForPath(file.filename),
  }));
  let mergeBasePromise: Promise<string> | undefined;
  const mergeBaseRef = () =>
    (mergeBasePromise ??= fetchMergeBase(token, repo, baseSha, review.headSha));
  unreadLockfiles.push(...(await changedResolutionConfig(context, files, mergeBaseRef)));
  unreadLockfiles.push(...(await changedInstallInputs(context, files)));
  if (lockfiles.length === 0) {
    unreadLockfiles.push(...(await unreadManifests(context, changed, heads, mergeBaseRef)));
    return { bumps: [], unreadLockfiles, listingComplete: complete };
  }

  const mergeBase = await mergeBaseRef();
  const registries = new Map<string, Promise<RegistryConfig>>();
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
      heads.push({
        path: file.filename,
        kind,
        text: null,
        manifest: null,
        workspaces: null,
        fallback,
      });
      continue;
    }
    const baseSnapshot = before
      ? parseLockfile(kind, before.text, { manifestText: before.manifest })
      : null;
    const headSnapshot = parseLockfile(kind, after.text, { manifestText: after.manifest });
    heads.push({
      path: file.filename,
      kind,
      text: after.text,
      manifest: after.manifest,
      workspaces: headSnapshot.complete ? headSnapshot.workspaces : null,
      fallback,
    });
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
      const config = await registries.get(dir)!;
      custom = config.registries;
      for (const path of config.unreadable) {
        if (!unreadLockfiles.includes(path)) unreadLockfiles.push(path);
      }
      // Peers the lockfile leaves out are installed at install time unless
      // the repository's config tells npm not to install peers.
      if (headSnapshot.unresolvedPeerEdges && !custom.legacyPeerDeps) {
        unreadLockfiles.push(file.filename);
        continue;
      }
    }
    // A requirements file never shows everything an install brings in: pip
    // resolves what it leaves out at install time, and builds a source
    // distribution's build requirements in an environment of their own,
    // outside the file and its hashes (hash-checking mode included). So
    // "nothing new entered the file" proves nothing about what a release's
    // new dependency installs.
    const pinsTree = kind !== "requirements";
    for (const change of diffLockfileChanges(baseSnapshot, headSnapshot, file.filename)) {
      // A name the repository routes to another registry is kept, never
      // diffed (unless proven a mirror copy): dropping it would let its
      // change pass unseen.
      const route = custom ? npmNameRoute(custom, change.bump.name) : PUBLIC_ROUTE;
      const bump = routedBump(change, route, collectionPolicy(policy));
      if (pinsTree) bump.lockfilePinsTree = true;
      const key = dependencyChangeKey(bump);
      const existing = byChange.get(key);
      if (existing) mergeBump(existing, bump);
      else byChange.set(key, { ...bump });
    }
  }
  for (const path of await unreadManifests(context, changed, heads, mergeBaseRef)) {
    if (!unreadLockfiles.includes(path)) unreadLockfiles.push(path);
  }
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

interface RegistryConfig {
  registries: CustomRegistries;
  // Config files that apply and could not be read; every name is then routed
  // somewhere unknown, and the files are reported as unread coverage.
  unreadable: string[];
}

// The `.npmrc` and `.yarnrc.yml` of the lockfile's directory and every one
// above it, at the head, merged.
async function readCustomRegistries(context: ReviewContext, dir: string): Promise<RegistryConfig> {
  const dirs = configAncestors(dir);
  if (dirs === null) return { registries: unreadableCustomRegistries(), unreadable: [] };
  const found = emptyCustomRegistries();
  const unreadable: string[] = [];
  const paths = dirs.flatMap((base) => [`${base}.npmrc`, `${base}.yarnrc.yml`]);
  const texts = await Promise.all(
    paths.map((path) =>
      readRepositoryFile(context.token, context.repo, path, context.review.headSha),
    ),
  );
  paths.forEach((path, i) => {
    const text = texts[i];
    if (text === null) return;
    const routing = text === "too-large" ? null : parseRoutingConfig(path, text);
    if (routing === null) unreadable.push(path);
    addRouting(found, routing);
  });
  return { registries: found, unreadable };
}

/**
 * Resolution config the PR adds, removes, or changes, which moves where
 * packages are fetched from without any lockfile showing it. A `.npmrc` or
 * `.yarnrc.yml` whose routing reads the same at the merge base and the head
 * changed nothing that matters; any other change (including to Yarn v1's
 * `.yarnrc`, `uv.toml`, `pip.conf`, and the `[tool.uv]` tables of a
 * `pyproject.toml`) is reported as unread.
 */
async function changedResolutionConfig(
  context: ReviewContext,
  files: readonly PullRequestFile[],
  mergeBaseRef: () => Promise<string>,
): Promise<string[]> {
  const unread: string[] = [];
  let inspected = 0;
  for (const file of files) {
    const path = file.filename;
    const kind = resolutionConfigKind(path);
    if (kind === null) continue;
    // A moved file applies to another directory than it did.
    if (kind === "opaque" || file.status === "renamed") {
      unread.push(path);
      continue;
    }
    if (inspected >= MAX_CONFIG_FILES) {
      unread.push(path);
      continue;
    }
    inspected += 1;
    const read = async (at: string | null, ref: () => Promise<string>) =>
      at === null ? null : readRepositoryFile(context.token, context.repo, at, await ref());
    const [before, after] = await Promise.all([
      read(file.status === "added" ? null : path, mergeBaseRef),
      read(file.status === "removed" ? null : path, async () => context.review.headSha),
    ]);
    if (resolutionConfigChanged(path, before, after)) unread.push(path);
  }
  return unread;
}

/**
 * Committed package caches and loaders the PR adds, removes, renames, or
 * changes (see `committedInstallInput`), one entry per directory. A Berry
 * cache can also sit under a `cacheFolder` named by a `.yarnrc.yml` read at
 * the head (a changed config is unread coverage already): the configs in and
 * above a changed zip's directory, and in and above the directory of each
 * `yarn.lock` the PR changes, whose cache may be anywhere in the repository.
 * A changed zip under a folder either set names reports that folder; Yarn
 * loads only zip archives from its cache, so the lockfile and any other file
 * under a `cacheFolder` of `.` are not cache content. That costs one
 * read per distinct directory, and only for PRs that change such a zip or a
 * `yarn.lock`; past `MAX_CONFIG_FILES` reads, or where a config does not read
 * strictly, each changed zip's directory is reported instead.
 */
async function changedInstallInputs(
  context: ReviewContext,
  files: readonly PullRequestFile[],
): Promise<string[]> {
  const found = new Set<string>();
  const zips: string[] = [];
  const lockDirs = new Set<string>();
  for (const file of files) {
    if (file.status !== "removed" && lockfileKindForPath(file.filename) === "yarn") {
      lockDirs.add(dirname(file.filename));
    }
    for (const path of [file.filename, file.previousFilename]) {
      if (!path) continue;
      const input = committedInstallInput(path);
      if (input !== null) found.add(input);
      else if (path.toLowerCase().endsWith(".zip")) zips.push(path);
    }
  }
  if (zips.length === 0 && lockDirs.size === 0) return [...found];
  const ancestors = new Map<string, string[] | null>();
  for (const dir of [...zips.map(dirname), ...lockDirs]) ancestors.set(dir, configAncestors(dir));
  const dirs = [...new Set([...ancestors.values()].flatMap((list) => list ?? []))];
  const folders = new Map<string, string | null | undefined>();
  if (dirs.length <= MAX_CONFIG_FILES) {
    const texts = await Promise.all(
      dirs.map((dir) =>
        readRepositoryFile(
          context.token,
          context.repo,
          `${dir}.yarnrc.yml`,
          context.review.headSha,
        ),
      ),
    );
    dirs.forEach((dir, i) => {
      const text = texts[i];
      folders.set(
        dir,
        text === null ? null : text === "too-large" ? undefined : yarnrcCacheFolder(dir, text),
      );
    });
  }
  // The folders the configs applying to `dir` name; null when one of them is
  // unbounded or may set a folder this cannot read.
  const namedFolders = (dir: string): string[] | null => {
    const list = ancestors.get(dir);
    if (!list || list.some((at) => !folders.has(at) || folders.get(at) === undefined)) return null;
    return list.map((at) => folders.get(at)).filter((folder) => typeof folder === "string");
  };
  // Where a cache's folder cannot be read, each changed zip's own directory
  // stands in for the cache it may be part of.
  for (const zip of zips) {
    const named = namedFolders(dirname(zip));
    if (named === null) found.add(dirname(zip));
    for (const folder of named ?? []) if (zip.startsWith(folder)) found.add(folder || "./");
  }
  for (const dir of lockDirs) {
    const named = namedFolders(dir);
    if (named === null) for (const zip of zips) found.add(dirname(zip));
    for (const folder of named ?? []) {
      if (zips.some((zip) => zip.startsWith(folder))) found.add(folder || "./");
    }
  }
  return [...found];
}

interface HeadLockfile {
  path: string;
  kind: LockfileKind;
  // Null when the lockfile went unread, which already holds the review.
  text: string | null;
  manifest: string | null;
  // The parsed head's workspace directories; null when it went unread.
  workspaces: ReadonlySet<string> | null;
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
 * in its own directory, or below it only when its parsed snapshot records that
 * directory as a workspace (see `LockfileSnapshot.workspaces`), or for Yarn
 * when the root manifest's `workspaces` globs match it: a root lockfile says
 * nothing about a sibling project with none.
 */
function uncoveredManifests(
  changed: readonly PullRequestFile[],
  heads: readonly HeadLockfile[],
): string[] {
  const yarnGlobs = new Map<HeadLockfile, RegExp[]>();
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
    // An unread lockfile already holds the review.
    if (head.workspaces === null) return true;
    const dir = manifestDir.slice(lockDir.length, -1);
    if (head.workspaces.has(dir)) return true;
    if (head.kind !== "yarn") return false;
    let globs = yarnGlobs.get(head);
    if (!globs) {
      globs = yarnWorkspaceGlobs(head.manifest);
      yarnGlobs.set(head, globs);
    }
    return dir.length <= 512 && globs.some((glob) => glob.test(dir));
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
