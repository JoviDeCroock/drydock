// Shared text-sample shedding for size-capped caches.
//
// Both cache payloads that carry redacted display samples — the anonymous
// `/diff` payload (`lib/public-diff`) and the authed compare payload
// (`lib/compare-cache`) — have to fit inside KV's 25 MiB value cap. A payload
// that does not fit is not cached at all, which turns every subsequent file view
// into a fresh download + parse of the whole release. Shedding the samples that
// buy the least review value keeps the entry cacheable instead.
//
// The primitives here are payload-shape agnostic: a caller measures its own
// metadata floor, asks which paths keep their sample inside the remaining
// budget, and applies the retention to each of its file lists. A path's samples
// are always kept or dropped together across lists, because a half-sampled
// modification would render as a whole-file addition or deletion.

import { jsonStringByteLength } from "../platform/json-size";
import type { FileRecord } from "./";

// Flags a record whose display sample was dropped to fit a cache budget, so the
// UI can say why the body is missing instead of implying the parser never
// captured one. Mirrored as a literal in src/components/DiffView.tsx alongside
// the parser's own flags.
export const SAMPLE_OMITTED_FLAG = "sample-omitted";

// JSON cost of `,"textSample":<value>` — the bytes a retained sample adds back
// to a record that would otherwise carry none.
const TEXT_SAMPLE_KEY_BYTES = ',"textSample":'.length;

export interface SampleCandidate {
  path: string;
  bytes: number;
  changed: boolean;
}

/**
 * Per-path sample cost across every supplied file list, ordered the way the
 * budget should be spent: changed paths first (they are what a workbench opens),
 * then unchanged package context, cheapest sample first inside each tier so the
 * budget buys the most reviewable files. `changedPaths` may be omitted when the
 * payload has no diff to prioritize by, in which case every candidate is treated
 * as unchanged and only the cheapest-first ordering applies.
 */
export function sampleCandidates(
  fileLists: ReadonlyArray<readonly FileRecord[]>,
  changedPaths?: ReadonlySet<string>,
): SampleCandidate[] {
  const byPath = new Map<string, SampleCandidate>();
  for (const files of fileLists) {
    for (const file of files) {
      if (!file.textSample) continue;
      const bytes = jsonStringByteLength(file.textSample) + TEXT_SAMPLE_KEY_BYTES;
      const existing = byPath.get(file.path);
      if (existing) existing.bytes += bytes;
      else {
        byPath.set(file.path, {
          path: file.path,
          bytes,
          changed: changedPaths ? changedPaths.has(file.path) : false,
        });
      }
    }
  }
  return [...byPath.values()].sort(
    (a, b) =>
      Number(b.changed) - Number(a.changed) || a.bytes - b.bytes || a.path.localeCompare(b.path),
  );
}

/**
 * Which candidate paths keep their sample inside `sampleBudget` bytes.
 * `unchangedBudgetBytes` caps how much of the budget unchanged files may claim:
 * every file navigation re-reads and re-parses the whole cached payload, so a
 * degraded payload that filled the full cap would trade one broken workbench for
 * a slow one. Changed files are not subject to that sub-cap.
 */
export function retainedSamplePaths(
  candidates: readonly SampleCandidate[],
  sampleBudget: number,
  unchangedBudgetBytes = sampleBudget,
): Set<string> {
  const retained = new Set<string>();
  let budget = sampleBudget;
  let unchangedBudget = Math.min(budget, unchangedBudgetBytes);
  for (const candidate of candidates) {
    // Keep scanning past an unaffordable candidate rather than stopping: each
    // tier is cheapest-first, so only a later tier can still yield a fit.
    if (candidate.bytes > budget) continue;
    if (!candidate.changed) {
      if (candidate.bytes > unchangedBudget) continue;
      unchangedBudget -= candidate.bytes;
    }
    budget -= candidate.bytes;
    retained.add(candidate.path);
  }
  return retained;
}

/** Drop every sample outside `retained`, flagging the records that lost one. */
export function applySampleRetention(
  files: readonly FileRecord[],
  retained: ReadonlySet<string>,
): FileRecord[] {
  return files.map((file) => {
    if (!file.textSample || retained.has(file.path)) return file;
    const { textSample: _omitted, ...rest } = file;
    return {
      ...rest,
      flags: rest.flags.includes(SAMPLE_OMITTED_FLAG)
        ? rest.flags
        : [...rest.flags, SAMPLE_OMITTED_FLAG],
    };
  });
}
