import { parseDocument } from "yaml";
import { isRecord } from "../platform/guards";
import { isSafeManifestPath } from "../platform/path-safety";
import { PublisherSetupError, validSetupSha, type SetupGithubClient } from "./setup-api";
import type { PublisherSetupContext } from "./setup-types";

const MAX_FILES = 48;
const MAX_FILE_BYTES = 24_000;
const MAX_TOTAL_BYTES = 96_000;
const MAX_MANIFESTS = 40;
const MAX_REQUESTS = 160;
const MAX_PATTERNS = 32;
const DIRECTORY = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/;
const SCRIPT = /^\.github\/scripts\/[A-Za-z0-9_.-]+\.(?:mjs|js|cjs)$/;

function parseEvidenceYaml(content: string): unknown {
  const document = parseDocument(content, { uniqueKeys: true });
  if (document.errors.length) throw new Error("invalid_yaml");
  return document.toJS({ maxAliasCount: 0 }) as unknown;
}

function scriptReferences(workflow: string, warn: (message: string) => void): string[] {
  let parsed: unknown;
  try {
    parsed = parseEvidenceYaml(workflow);
  } catch {
    warn("Workflow script references could not be inspected as bounded YAML.");
    return [];
  }
  const scripts = new Set<string>();
  if (!isRecord(parsed) || !isRecord(parsed.jobs)) return [];
  const runDirectory = (owner: Record<string, unknown>) =>
    isRecord(owner.defaults) && isRecord(owner.defaults.run)
      ? owner.defaults.run["working-directory"]
      : undefined;
  for (const job of Object.values(parsed.jobs)) {
    if (!isRecord(job) || !Array.isArray(job.steps)) continue;
    for (const step of job.steps) {
      if (!isRecord(step)) continue;
      const commands: { text: string; directory: unknown }[] =
        typeof step.run === "string"
          ? [
              {
                text: step.run,
                directory: step["working-directory"] ?? runDirectory(job) ?? runDirectory(parsed),
              },
            ]
          : [];
      if (
        typeof step.uses === "string" &&
        step.uses.startsWith("changesets/action@") &&
        isRecord(step.with)
      )
        for (const key of ["publish", "version"])
          if (typeof step.with[key] === "string")
            commands.push({
              text: step.with[key],
              directory: step.with.cwd ?? step["working-directory"],
            });
      for (const command of commands) {
        const text = command.text
          .split(/\r?\n/)
          .filter((line) => !line.trimStart().startsWith("#"))
          .join("\n");
        if (!text.includes(".github/scripts/")) continue;
        if (
          (command.directory !== undefined &&
            command.directory !== "." &&
            command.directory !== "./") ||
          /\b(?:cd|pushd)[ \t]+(?!\.(?:\/)?[ \t]*(?:&&|[;\r\n]|$))/.test(text)
        ) {
          warn(
            "Release-script references outside the literal repository root require manual setup.",
          );
          continue;
        }
        const resolved = new Set<string>();
        for (const match of text.matchAll(
          /(?:^|[\s;&|])node[ \t]+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s;&|]+))/g,
        )) {
          const path = (match[1] ?? match[2] ?? match[3] ?? "").replace(/^\.\//, "");
          if (SCRIPT.test(path) && isSafeManifestPath(path)) {
            scripts.add(path);
            resolved.add(path);
          } else if (
            path.includes(".github/scripts/") ||
            text
              .slice((match.index ?? 0) + match[0].length)
              .split(/[;\n|&]/, 1)[0]
              ?.includes(".github/scripts/")
          )
            warn("Nonliteral or unsupported release-script references were skipped.");
        }
        for (const reference of text.matchAll(/(?:\.\/)?\.github\/scripts\/[^\s'"`;|&]+/g))
          if (!resolved.has(reference[0].replace(/^\.\//, "")))
            warn("Nonliteral or unsupported release-script references were skipped.");
      }
    }
  }
  return [...scripts];
}

/** Reads only allowlisted evidence; Git trees prove Contents did not dereference a symlink. */
export async function readSetupContext(
  client: SetupGithubClient,
  workflow: string,
  baseSha: string,
): Promise<PublisherSetupContext> {
  if (!validSetupSha(baseSha))
    throw new PublisherSetupError("invalid_input", "Choose a valid repository revision.");
  const context: PublisherSetupContext = { files: [], warnings: [] };
  const warn = (message: string) => {
    if (!context.warnings.includes(message)) context.warnings.push(message);
  };
  let requests = 0;
  let totalBytes = 0;
  const trees = new Map<string, Record<string, unknown>[] | null>();
  async function request(suffix: string): Promise<unknown> {
    if (requests >= MAX_REQUESTS) {
      warn("Supporting-context request limit reached; repository evidence is incomplete.");
      return null;
    }
    requests++;
    try {
      return await client.request(suffix, {}, true);
    } catch {
      warn("Some supporting repository evidence could not be read.");
      return null;
    }
  }
  async function tree(directory: string): Promise<Record<string, unknown>[] | null> {
    if (trees.has(directory)) return trees.get(directory) ?? null;
    let sha = baseSha;
    if (directory) {
      const parent = directory.includes("/") ? directory.slice(0, directory.lastIndexOf("/")) : "";
      const name = directory.slice(parent ? parent.length + 1 : 0);
      const entry = (await tree(parent))?.find((value) => value.path === name);
      if (!entry) {
        trees.set(directory, null);
        return null;
      }
      if (
        entry.type !== "tree" ||
        entry.mode !== "040000" ||
        typeof entry.sha !== "string" ||
        !validSetupSha(entry.sha)
      ) {
        warn("Symlink or unsupported supporting-context directories were skipped.");
        trees.set(directory, null);
        return null;
      }
      sha = entry.sha;
    }
    const data = await request(`/git/trees/${sha}`);
    if (
      !isRecord(data) ||
      !Array.isArray(data.tree) ||
      data.truncated !== false ||
      data.tree.length > 512 ||
      !data.tree.every(isRecord)
    ) {
      warn("A supporting-context directory was unavailable or exceeded its bounded listing limit.");
      trees.set(directory, null);
      return null;
    }
    trees.set(directory, data.tree);
    return data.tree;
  }
  async function file(path: string, required = false): Promise<void> {
    if (context.files.some((value) => value.path === path)) return;
    if (context.files.length >= MAX_FILES) {
      warn("Supporting-context file limit reached; repository evidence is incomplete.");
      return;
    }
    if (!isSafeManifestPath(path)) {
      warn("An unsupported supporting-context path was skipped.");
      return;
    }
    const separator = path.lastIndexOf("/");
    const directory = separator < 0 ? "" : path.slice(0, separator);
    const name = path.slice(separator + 1);
    const entry = (await tree(directory))?.find((value) => value.path === name);
    if (!entry) {
      if (required)
        warn("A referenced release script was missing or unavailable at the pinned revision.");
      return;
    }
    if (
      entry.type !== "blob" ||
      (entry.mode !== "100644" && entry.mode !== "100755") ||
      typeof entry.sha !== "string" ||
      !validSetupSha(entry.sha)
    ) {
      warn("Symlink or unsupported supporting-context files were skipped.");
      return;
    }
    const data = await request(
      `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${baseSha}`,
    );
    if (
      !isRecord(data) ||
      data.type !== "file" ||
      data.path !== path ||
      data.sha !== entry.sha ||
      data.encoding !== "base64" ||
      typeof data.content !== "string" ||
      typeof data.size !== "number" ||
      !Number.isSafeInteger(data.size) ||
      data.size < 0 ||
      data.size > MAX_FILE_BYTES ||
      data.content.length > MAX_FILE_BYTES * 1.5 ||
      "target" in data ||
      "submodule_git_url" in data
    ) {
      warn("Some supporting files were not regular UTF-8 files within the 24 KB limit.");
      return;
    }
    try {
      const bytes = Uint8Array.from(atob(data.content.replace(/\s/g, "")), (value) =>
        value.charCodeAt(0),
      );
      if (bytes.length !== data.size || bytes.length > MAX_FILE_BYTES)
        throw new Error("invalid_size");
      if (totalBytes + bytes.length > MAX_TOTAL_BYTES) {
        warn("Supporting-context 96 KB total limit reached; repository evidence is incomplete.");
        return;
      }
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (content.includes("\0")) throw new Error("binary");
      context.files.push({ path, sha: entry.sha, content });
      totalBytes += bytes.length;
    } catch {
      warn("Some supporting files could not be decoded as bounded UTF-8 text.");
    }
  }
  for (const path of ["package.json", "pnpm-workspace.yaml", ".changeset/config.json"])
    await file(path);
  for (const path of scriptReferences(workflow, warn)) await file(path, true);
  const patterns: unknown[] = ["packages/*"];
  const root = context.files.find((value) => value.path === "package.json");
  if (root) {
    try {
      const manifest: unknown = JSON.parse(root.content);
      if (isRecord(manifest)) {
        const workspaces = isRecord(manifest.workspaces)
          ? manifest.workspaces.packages
          : manifest.workspaces;
        if (Array.isArray(workspaces)) patterns.push(...workspaces.slice(0, MAX_PATTERNS + 1));
      }
    } catch {
      warn("Root package workspace configuration could not be inspected.");
    }
  }
  const pnpm = context.files.find((value) => value.path === "pnpm-workspace.yaml");
  if (pnpm) {
    try {
      const config = parseEvidenceYaml(pnpm.content);
      if (isRecord(config) && Array.isArray(config.packages))
        patterns.push(...config.packages.slice(0, MAX_PATTERNS + 1));
    } catch {
      warn("pnpm workspace configuration could not be inspected.");
    }
  }
  let manifests = 0;
  const directories = new Set<string>();
  if (patterns.length > MAX_PATTERNS)
    warn("Workspace pattern limit reached; repository evidence is incomplete.");
  for (const pattern of patterns.slice(0, MAX_PATTERNS)) {
    if (typeof pattern !== "string") {
      warn("Unsupported workspace patterns were skipped.");
      continue;
    }
    const wildcard = pattern.endsWith("/*");
    const directory = wildcard ? pattern.slice(0, -2) : pattern;
    if (
      !DIRECTORY.test(directory) ||
      !isSafeManifestPath(directory) ||
      directory.split("/").length > 6
    ) {
      warn("Recursive, negative, dynamic, or unsupported workspace patterns were skipped.");
      continue;
    }
    const discovered: string[] = [];
    if (!wildcard) discovered.push(directory);
    else {
      const entries = await tree(directory);
      if (!entries) continue;
      if (entries.some((entry) => entry.mode === "120000"))
        warn("Symlink workspace entries were skipped.");
      const listing = await request(
        `/contents/${directory.split("/").map(encodeURIComponent).join("/")}?ref=${baseSha}`,
      );
      if (!Array.isArray(listing) || listing.length > 256) {
        warn("Workspace directory listing was unavailable or exceeded its limit.");
        continue;
      }
      for (const entry of listing) {
        if (
          isRecord(entry) &&
          entry.type === "dir" &&
          typeof entry.name === "string" &&
          DIRECTORY.test(entry.name) &&
          !entry.name.includes("/") &&
          entry.path === `${directory}/${entry.name}`
        )
          discovered.push(entry.path);
        else if (isRecord(entry) && entry.type === "dir")
          warn("Unsupported workspace directory paths were skipped.");
      }
    }
    for (const child of discovered.sort()) {
      if (directories.has(child)) continue;
      if (manifests >= MAX_MANIFESTS) {
        warn("Workspace manifest limit reached; repository evidence is incomplete.");
        break;
      }
      directories.add(child);
      manifests++;
      await file(`${child}/package.json`);
    }
  }
  return context;
}
