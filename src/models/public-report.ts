/**
 * One shared review, read anonymously through its share token.
 *
 * The token is the whole capability, so everything here goes to `/public/*` and
 * carries no credentials. Two documents back the page: the canonical report
 * export (risk, diff, findings) and, lazily per selected file, the redacted
 * staged sample from `/public/reports/:token/file`. There is no baseline side —
 * fetching a published previous version spends the organization's npm
 * credentials, which a public route never holds.
 */
import { batch, computed, createModel, signal } from "@preact/signals";
import { normalizeFindingDiffStatus, type DiffEntry } from "../../server/lib/review";
import { sortFindingsBySeverity } from "../lib/findings";
import type { DiffFinding } from "../components/diff-annotations";
import { findingCountsByPath } from "../features/review/diff-entries";
import type { FindingWithDiffStatus } from "../features/review/types";

// The canonical report export served at /public/reports/:token — the same
// document `serializeReportExport` produces (schema drydock.report.v2).
export interface PublicReport {
  schema: string;
  scan: {
    id: string;
    status: string;
    source: string;
    risk: string;
    decision: string | null;
    createdAt: string | null;
    completedAt: string | null;
  };
  package: {
    name: string | null;
    stagedVersion: string | null;
    previousVersion: string | null;
  };
  riskSummary: {
    releaseRisk: string;
    contextRisk: string;
    releaseFindingCount: number;
    contextFindingCount: number;
  } | null;
  diff: PublicReportDiffEntry[] | null;
  findings: PublicReportFinding[];
}

export interface PublicReportDiffEntry {
  path: string;
  status: string;
  previousSize?: number | null;
  stagedSize?: number | null;
  previousSha256?: string | null;
  stagedSha256?: string | null;
  flags?: unknown;
}

export interface PublicReportFinding {
  severity: string;
  file: string;
  line: number | null;
  ruleId: string | null;
  diffStatus: string | null;
  releaseDelta: boolean | null;
  evidence: string;
  reason: string;
}

// One redacted staged file sample, as persisted in the scan's files artifact.
export interface PublicReportFile {
  path: string;
  status: string;
  size: number | null;
  sha256: string | null;
  flagsJson: unknown;
  textSample: string | null;
}

export type PublicReportErrorState = "none" | "not_found" | "failed";
const SHARE_INCLUDES_FILES_HEADER = "x-drydock-share-includes-files";

const DIFF_STATUSES = new Set<DiffEntry["status"]>(["added", "removed", "modified", "unchanged"]);

/**
 * The report's persisted diff, normalized into the shape the shared release
 * tree and `DiffView` take. Reports exported before a field existed simply omit
 * it, so every optional is defaulted rather than asserted — a legacy report
 * must still render a tree instead of blanking the page.
 */
export function publicReportDiffEntries(diff: PublicReportDiffEntry[] | null): DiffEntry[] {
  if (!Array.isArray(diff)) return [];
  return diff.flatMap((entry) => {
    if (!entry || typeof entry.path !== "string") return [];
    return [
      {
        path: entry.path,
        status: DIFF_STATUSES.has(entry.status as DiffEntry["status"])
          ? (entry.status as DiffEntry["status"])
          : "unchanged",
        previousSize: entry.previousSize ?? undefined,
        stagedSize: entry.stagedSize ?? undefined,
        previousSha256: entry.previousSha256 ?? undefined,
        stagedSha256: entry.stagedSha256 ?? undefined,
        flags: Array.isArray(entry.flags)
          ? entry.flags.filter((flag): flag is string => typeof flag === "string")
          : [],
      },
    ];
  });
}

/**
 * Report findings projected into the shared review shape, so the public report
 * renders the same risk index, tree counts, and inline diff annotations as the
 * authenticated workbench.
 *
 * The export carries no finding id — that is a persistence detail the public
 * document deliberately omits — so one is derived from the entry's position in
 * the export's stable sort. It is a render key, never an identifier a reader
 * could carry back to a scan.
 */
export function publicReportFindingItems(findings: PublicReportFinding[]): FindingWithDiffStatus[] {
  return findings.map((finding, index) => ({
    finding: {
      id: `${index}:${finding.file}:${finding.ruleId ?? ""}:${finding.line ?? ""}`,
      severity: finding.severity,
      file: finding.file,
      evidence: finding.evidence,
      reason: finding.reason,
      line: finding.line,
      source: "rule",
      ruleId: finding.ruleId,
    },
    diffStatus: normalizeFindingDiffStatus(finding.diffStatus),
    releaseDelta: Boolean(finding.releaseDelta),
  }));
}

/**
 * A file whose body the scanner never captured as text. Neither can be fetched,
 * so the panel shows the metadata placeholder rather than spinning on a request
 * that would only 404.
 */
export function hasNoLoadableBody(flags: readonly string[]): boolean {
  return flags.includes("binary") || flags.includes("content-skipped");
}

export const PublicReportModel = createModel(() => {
  // Held as a signal rather than closed over, so routing between two report
  // links reuses the model instead of stranding it on the first token.
  const token = signal("");
  const report = signal<PublicReport | null>(null);
  const includesFiles = signal(false);
  const attestationAvailable = signal(false);
  const errorState = signal<PublicReportErrorState>("none");
  const selectedPath = signal<string | null>(null);
  const fileCache = signal<Record<string, PublicReportFile>>({});
  // Paths the endpoint refused. Cached so a missing sample is asked for once,
  // not on every rerender of the panel that shows the placeholder.
  const fileMisses = signal<Record<string, true>>({});
  const loadingPath = signal<string | null>(null);

  const diffEntries = computed(() => publicReportDiffEntries(report.value?.diff ?? null));
  const findingItems = computed(() => publicReportFindingItems(report.value?.findings ?? []));
  const findingCounts = computed(() => findingCountsByPath(findingItems.value));

  const selectedEntry = computed(() => {
    const path = selectedPath.value;
    const entries = diffEntries.value;
    if (!path) return null;
    return entries.find((entry) => entry.path === path) ?? null;
  });

  const selectedFile = computed(() => {
    const path = selectedPath.value;
    const cache = fileCache.value;
    return path ? (cache[path] ?? null) : null;
  });

  // Deterministic findings for the open file, pinned to their staged line
  // inside DiffView rather than listed separately (diff-first direction).
  const selectedFindings = computed<DiffFinding[]>(() => {
    const path = selectedPath.value;
    const items = findingItems.value;
    if (!path) return [];
    return sortFindingsBySeverity(
      items.filter((item) => item.finding.file === path).map((item) => item.finding),
    );
  });

  async function load(nextToken: string) {
    batch(() => {
      token.value = nextToken;
      report.value = null;
      includesFiles.value = false;
      errorState.value = "none";
      // selectedPath is deliberately left alone: it is bound to the `path`
      // query parameter, and clearing it here would discard the file a
      // deep-linked share URL asked for before the report even arrived.
      fileCache.value = {};
      fileMisses.value = {};
      loadingPath.value = null;
    });
    const keyRequest = fetch("/public/attestation-key", {
      headers: { accept: "application/json" },
    }).catch(() => null);
    try {
      const res = await fetch(`/public/reports/${encodeURIComponent(nextToken)}`, {
        headers: { accept: "application/json" },
      });
      if (res.status === 404) {
        errorState.value = "not_found";
        return;
      }
      if (!res.ok) {
        errorState.value = "failed";
        return;
      }
      const data = (await res.json()) as PublicReport;
      const nextIncludesFiles = res.headers.get(SHARE_INCLUDES_FILES_HEADER) === "1";
      const keyResponse = await keyRequest;
      if (token.peek() !== nextToken) return;
      batch(() => {
        report.value = data;
        includesFiles.value = nextIncludesFiles;
        attestationAvailable.value = keyResponse?.ok ?? false;
      });
    } catch {
      errorState.value = "failed";
    }
  }

  async function loadFile(path: string) {
    if (!includesFiles.peek()) return;
    if (fileCache.peek()[path] || fileMisses.peek()[path]) return;
    loadingPath.value = path;
    try {
      const res = await fetch(
        `/public/reports/${encodeURIComponent(token.peek())}/file?path=${encodeURIComponent(path)}`,
        { headers: { accept: "application/json" } },
      );
      if (!res.ok) {
        fileMisses.value = { ...fileMisses.peek(), [path]: true };
        return;
      }
      const { file } = (await res.json()) as { file: PublicReportFile };
      fileCache.value = { ...fileCache.peek(), [path]: file };
    } catch {
      fileMisses.value = { ...fileMisses.peek(), [path]: true };
    } finally {
      if (loadingPath.peek() === path) loadingPath.value = null;
    }
  }

  return {
    report,
    includesFiles,
    attestationAvailable,
    errorState,
    selectedPath,
    loadingPath,
    fileMisses,
    diffEntries,
    findingItems,
    findingCounts,
    selectedEntry,
    selectedFile,
    selectedFindings,
    load,
    loadFile,
    selectPath: (path: string) => (selectedPath.value = path),
  };
});
