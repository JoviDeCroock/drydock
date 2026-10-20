import { shouldSkipTextSample, type TarSuspiciousEntry } from "../../tar-parser.js";
import type { DiffEntry } from "../diff";
import type { FileRecord, Finding, FindingSeverity } from "../types";
import { DETERMINISTIC_RULE_IDS } from "./rule-ids";

// Archive-structure findings from the tar parser's suspicious-entry report.
// Stamped with the ruleset version by `rules/index.ts` like every other family.
export function tarEntryFindings(
  entries: TarSuspiciousEntry[] | undefined | null,
  options: TarEntryFindingOptions = {},
): Finding[] {
  if (!entries || !entries.length) return [];
  const hasChangedSkippedContent = hasChangedUninspectedContent(options);
  return entries.map((entry) => ({
    severity: tarSuspiciousSeverity(entry, hasChangedSkippedContent),
    file: entry.path || "<unknown>",
    evidence: `${entry.kind}: ${entry.detail}`,
    reason: tarSuspiciousReason(entry, options.dialect ?? "npm"),
    ruleId: DETERMINISTIC_RULE_IDS.tarSuspiciousEntry,
  }));
}

export interface TarEntryFindingOptions {
  dialect?: "npm" | "pypi";
  fileDiff?: Array<Pick<DiffEntry, "status" | "flags"> & { path?: string }>;
  /**
   * The reviewed side's records. A diff entry's flags are the union of both
   * sides, so without these a file the baseline stored hash-only but this
   * release fully inspected would read as an uninspected change.
   */
  stagedFiles?: Array<Pick<FileRecord, "path" | "flags"> & Partial<Pick<FileRecord, "textSample">>>;
}

// Whether the retention tier cost this release any inspection: a file that
// changed relative to the baseline (by sha256) and whose reviewed body was
// recorded hash-only. Bodies that would carry no text sample even if retained
// do not count, because the tier hid nothing the content rules would have
// read: a sniffed native binary (which `file.native-artifact` already reports
// from the same magic-byte flag), and the source maps / minified bundles the
// parser never samples. A never-sampled bundle that a manifest entrypoint
// names or shipped code refers to still counts: it is the code that runs.
function hasChangedUninspectedContent(options: TarEntryFindingOptions): boolean {
  const stagedFlags = options.stagedFiles
    ? new Map(options.stagedFiles.map((file) => [file.path, file.flags]))
    : null;
  const neverSampled: string[] = [];
  for (const entry of options.fileDiff ?? []) {
    if (entry.status !== "added" && entry.status !== "modified") continue;
    const flags = (entry.path !== undefined && stagedFlags?.get(entry.path)) || entry.flags;
    if (!flags.includes("content-skipped")) continue;
    if (flags.some((flag) => flag.startsWith("native-"))) continue;
    if (entry.path === undefined || !shouldSkipTextSample(entry.path)) return true;
    neverSampled.push(entry.path);
  }
  return neverSampled.length > 0 && isAnyBundleLoaded(neverSampled, options.stagedFiles ?? []);
}

// File-name tokens in shipped text, minus `sourceMappingURL` comments (every
// bundle names its own map). Matching is by basename, so a reference through
// `path.join(__dirname, "app.min.js")` or `require("./app.min")` counts, at
// the cost of a same-named file elsewhere also counting.
const SOURCE_MAP_COMMENT = /[#@]\s*sourceMappingURL\s*=\s*\S*/g;
const FILE_NAME_TOKEN = /[^\s'"`\\/()+,;:=<>{}[\]|&*?!]+/g;
const CODE_EXTENSION = /\.[cm]?js$/;

// The shipped text is hostile and its token count is bounded only by the
// retained bytes, so tokens are streamed against the few names being looked
// for rather than collected; memory stays proportional to the candidates.
function isAnyBundleLoaded(
  paths: string[],
  stagedFiles: NonNullable<TarEntryFindingOptions["stagedFiles"]>,
): boolean {
  const entrypoints = manifestEntrypoints(stagedFiles);
  const wanted = new Set<string>();
  for (const path of paths) {
    const normalized = path.toLowerCase();
    if (entrypoints.has(normalized)) return true;
    const basename = normalized.split("/").at(-1) ?? "";
    wanted.add(basename);
    wanted.add(basename.replace(CODE_EXTENSION, ""));
  }
  for (const file of stagedFiles) {
    if (!file.textSample || /(?:^|\/)package\.json$/i.test(file.path)) continue;
    const text = file.textSample.replace(SOURCE_MAP_COMMENT, "");
    for (const [token] of text.matchAll(FILE_NAME_TOKEN)) {
      if (wanted.has(token.toLowerCase())) return true;
    }
  }
  return false;
}

// Every path string under the shallowest manifest's entrypoint fields
// (`main`, `module`, `browser`, `bin`, `exports`), resolved from its directory.
function manifestEntrypoints(
  stagedFiles: NonNullable<TarEntryFindingOptions["stagedFiles"]>,
): Set<string> {
  const manifest = stagedFiles
    .filter((file) => file.textSample && /(?:^|\/)package\.json$/i.test(file.path))
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length)[0];
  const targets = new Set<string>();
  if (!manifest?.textSample) return targets;
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest.textSample);
  } catch {
    return targets;
  }
  if (!parsed || typeof parsed !== "object") return targets;
  const directory = manifest.path.split("/").slice(0, -1).join("/");
  const fields = parsed as Record<string, unknown>;
  const pending: unknown[] = [
    fields.main,
    fields.module,
    fields.browser,
    fields.bin,
    fields.exports,
  ];
  for (let visited = 0; pending.length && visited < 10_000; visited += 1) {
    const value = pending.pop();
    if (typeof value === "string") {
      const relative = value
        .replaceAll("\\", "/")
        .replace(/^(?:\.\/)+/, "")
        .replace(/^\/+/, "");
      targets.add((directory ? `${directory}/${relative}` : relative).toLowerCase());
    } else if (value && typeof value === "object") {
      // A loop, not a spread: a hostile manifest's object can hold more
      // values than a call has room for arguments.
      for (const entry of Object.values(value)) pending.push(entry);
    }
  }
  return targets;
}

function tarSuspiciousSeverity(
  entry: TarSuspiciousEntry,
  hasChangedSkippedContent: boolean,
): FindingSeverity {
  if (entry.kind === "non-regular") {
    return entry.detail.includes("(directory)") ? "info" : "high";
  }
  if (entry.kind === "retention-tier") {
    return hasChangedSkippedContent ? "medium" : "info";
  }
  // A structure that makes tar readers disagree is review evasion by
  // construction: no publisher toolchain emits one.
  if (entry.kind === "parser-differential") return "high";
  return "medium";
}

function tarSuspiciousReason(entry: TarSuspiciousEntry, dialect: "npm" | "pypi"): string {
  switch (entry.kind) {
    case "non-regular":
      if (entry.detail.includes("(directory)")) {
        return dialect === "pypi"
          ? "archive contains an explicit directory entry; Python build backends normally emit these, so this is recorded for provenance but does not by itself indicate executable or link behavior"
          : "archive contains an explicit directory entry; npm pack normally emits regular file records, so this is recorded for provenance but does not by itself indicate executable or link behavior";
      }
      return dialect === "pypi"
        ? "Python build backends only emit regular file and directory records; symlinks, hardlinks, devices, FIFOs, or reserved entries in an sdist indicate a hand-crafted archive that may target the consumer's filesystem on extract"
        : "npm publish only emits regular files; symlinks, hardlinks, devices, FIFOs, directories, or reserved entries in a tarball indicate a hand-crafted archive that may target the consumer's filesystem on extract";
    case "duplicate":
      return "two entries share the same normalized path; last-write-wins extraction means a benign first entry can mask a malicious second";
    case "unicode-confusable":
      return "path contains zero-width or visually-confusable characters; the consumer's tar implementation may canonicalize this differently than the reviewer and let it bypass deterministic file checks";
    case "content-skipped":
      return "file body exceeded the scanner's retention limit, so only its path, size, and content hash were recorded; the content was never inspected — the diff's baseline hash comparison shows whether it changed, and its contents must be verified through provenance or out-of-band review";
    case "retention-tier":
      return "the archive is larger than the scanner's full-inspection tier, so some file bodies were recorded hash-only and never content-inspected; the diff's baseline hash comparison still shows whether each one changed, and changed-but-uninspected files must be verified through provenance or out-of-band review";
    case "parser-differential":
      return dialect === "pypi"
        ? "the archive uses a structure that tar readers resolve differently, named in the evidence. Drydock resolves it the way node-tar does, which is not always how pip's CPython `tarfile` reads it, so an entry recorded here may not be one pip extracts — but no Python build backend emits these shapes, and the disagreement is itself the evidence"
        : "the archive uses a structure that tar readers resolve differently, named in the evidence. Drydock resolves it the way node-tar does, because that is the reader `npm install` extracts with, so a reviewer reading the archive any other way sees a different set of files than npm installs. npm pack never emits these shapes — they are how files are hidden from review";
  }
}
