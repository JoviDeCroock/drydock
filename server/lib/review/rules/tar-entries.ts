import type { TarSuspiciousEntry } from "../../tar-parser.js";
import type { DiffEntry } from "../diff";
import type { Finding, FindingSeverity } from "../types";
import { DETERMINISTIC_RULE_IDS } from "./rule-ids";

// Archive-structure findings from the tar parser's suspicious-entry report.
// Stamped with the ruleset version by `rules/index.ts` like every other family.
export function tarEntryFindings(
  entries: TarSuspiciousEntry[] | undefined | null,
  options: {
    dialect?: "npm" | "pypi";
    fileDiff?: Array<Pick<DiffEntry, "status" | "flags">>;
  } = {},
): Finding[] {
  if (!entries || !entries.length) return [];
  const hasChangedSkippedContent = (options.fileDiff ?? []).some(
    (entry) =>
      (entry.status === "added" || entry.status === "modified") &&
      entry.flags.includes("content-skipped"),
  );
  return entries.map((entry) => ({
    severity: tarSuspiciousSeverity(entry, hasChangedSkippedContent),
    file: entry.path || "<unknown>",
    evidence: `${entry.kind}: ${entry.detail}`,
    reason: tarSuspiciousReason(entry, options.dialect ?? "npm"),
    ruleId: DETERMINISTIC_RULE_IDS.tarSuspiciousEntry,
  }));
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
