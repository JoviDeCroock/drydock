import { isRecord } from "../platform/guards";
import { bumpIdentityKey } from "./identity";
import type { BumpEvidence, DependencyBump } from "./types";

/**
 * What the first pass collected for this head, so later passes skip reading
 * every lockfile again. Kept with the mirror prefixes it was collected under:
 * a changed mirror list re-collects.
 */
export interface StoredCollection {
  publicMirrors: string[];
  bumps: DependencyBump[];
  unreadLockfiles: string[];
  listingComplete: boolean;
}

/**
 * What a review has learned so far, stored on its row (`progress_json`) so a
 * review that needs more than one queue invocation continues where the last
 * pass stopped. Everything here is policy-independent: the policy and the
 * approvals are applied once, by the final pass.
 */
export interface DependencyReviewProgress {
  // When the first pass started (epoch ms), for the review's total duration.
  startedAt: number;
  // Passes started, counted before each does any work, so a pass the
  // platform kills still counts toward the bound.
  passes: number;
  // Bumps the last pass collected, and how many of them were settled.
  total: number;
  settled: number;
  bumps: Record<string, StoredBumpProgress>;
  collected?: StoredCollection;
}

export interface StoredBumpProgress {
  evidence?: BumpEvidence;
  // A diff outcome the public diff does not cache, kept so later passes don't
  // retry it.
  unreviewed?: "not-found" | "unsupported" | "failed";
  // The target version's public publish time; null when the lookup found none.
  publishedAt?: string | null;
  // `verifyMirrorBump`'s answer for a mirror-resolved bump.
  mirrorVerified?: boolean;
  // `verifyPublicPin`'s answer for a public bump with `pinnedHashes`.
  pinVerified?: boolean;
  // Cold diffs started on this bump that never recorded an outcome: each one
  // is written before the diff runs, so a pass the platform kills mid-diff
  // leaves the count behind.
  coldStarts?: number;
}

// Above this the stored findings are trimmed (counts stay): the row also
// carries `bumps_json`, and D1 caps a row near 2 MB.
const MAX_PROGRESS_CHARS = 700_000;
// A collection past this is not kept; each pass collects again instead.
const MAX_COLLECTION_CHARS = 300_000;

/** The collection to keep for later passes, or undefined when it is too large. */
export function storableCollection(collection: StoredCollection): StoredCollection | undefined {
  return JSON.stringify(collection).length <= MAX_COLLECTION_CHARS ? collection : undefined;
}

export function emptyProgress(nowMs: number): DependencyReviewProgress {
  return { startedAt: nowMs, passes: 0, total: 0, settled: 0, bumps: {} };
}

/**
 * The identity a stored outcome belongs to: the change as collected, before
 * any proof (`bumpIdentityKey`). A proof is stored under the exact hashes it
 * proved, so two pins of the same versions never share one.
 */
export function bumpProgressKey(bump: DependencyBump): string {
  return bumpIdentityKey(bump);
}

/** Stored progress, or a fresh one when the row has none or it is unreadable. */
export function parseProgress(text: string | null, nowMs: number): DependencyReviewProgress {
  if (!text) return emptyProgress(nowMs);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return emptyProgress(nowMs);
  }
  if (!isRecord(value) || !isRecord(value.bumps)) return emptyProgress(nowMs);
  const number = (raw: unknown, fallback: number) =>
    typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
  return {
    startedAt: number(value.startedAt, nowMs),
    passes: number(value.passes, 0),
    total: number(value.total, 0),
    settled: number(value.settled, 0),
    bumps: value.bumps as Record<string, StoredBumpProgress>,
    ...(isRecord(value.collected) &&
    Array.isArray(value.collected.bumps) &&
    Array.isArray(value.collected.unreadLockfiles) &&
    Array.isArray(value.collected.publicMirrors)
      ? { collected: value.collected as unknown as StoredCollection }
      : {}),
  };
}

/** A newer claim owns the review; the pass holding the old one must stop. */
export class DependencyReviewStalePassError extends Error {
  constructor() {
    super("a newer pass owns this review");
    this.name = "DependencyReviewStalePassError";
  }
}

// A pass flushes after this many new outcomes or this long since the last
// write, whichever comes first, and once more at its end. An `urgent` outcome
// (a cold diff, which can cost seconds of CPU) is written at once, so a pass
// the CPU limit kills never redoes one.
const FLUSH_EVERY_OUTCOMES = 8;
const FLUSH_EVERY_MS = 5_000;

/**
 * Records outcomes as a pass learns them and writes them in batches. `save`
 * is the fenced write (`saveDependencyReviewProgress`); a refused write means
 * the claim moved on, which surfaces as `DependencyReviewStalePassError`.
 */
export class ProgressWriter {
  readonly progress: DependencyReviewProgress;
  private readonly save: (json: string) => Promise<boolean>;
  private unsaved = 0;
  private lastSavedAt = Date.now();
  private writing: Promise<void> = Promise.resolve();

  constructor(progress: DependencyReviewProgress, save: (json: string) => Promise<boolean>) {
    this.progress = progress;
    this.save = save;
  }

  async record(
    key: string,
    update: StoredBumpProgress,
    options: { urgent?: boolean } = {},
  ): Promise<void> {
    this.progress.bumps[key] = { ...this.progress.bumps[key], ...update };
    this.unsaved += 1;
    if (
      options.urgent ||
      this.unsaved >= FLUSH_EVERY_OUTCOMES ||
      Date.now() - this.lastSavedAt >= FLUSH_EVERY_MS
    ) {
      await this.flush();
    }
  }

  /** Writes everything recorded so far; one write runs at a time. */
  flush(): Promise<void> {
    this.unsaved = 0;
    this.lastSavedAt = Date.now();
    this.writing = this.writing.then(async () => {
      if (!(await this.save(serializeProgress(this.progress)))) {
        throw new DependencyReviewStalePassError();
      }
    });
    return this.writing;
  }
}

function serializeProgress(progress: DependencyReviewProgress): string {
  const text = JSON.stringify(progress);
  if (text.length <= MAX_PROGRESS_CHARS) return text;
  const trimmed: Record<string, StoredBumpProgress> = {};
  for (const [key, entry] of Object.entries(progress.bumps)) {
    trimmed[key] = entry.evidence
      ? { ...entry, evidence: { ...entry.evidence, findings: entry.evidence.findings.slice(0, 1) } }
      : entry;
  }
  return JSON.stringify({ ...progress, bumps: trimmed });
}
