// Sample-retention budgets. Dependency-free on purpose: ecosystem brokers (some
// of which are imported by node-env logic tests) and the persistence layer both
// read these, and neither should have to pull in the sandbox module to do it.

/**
 * Per-file display sample bound applied at persistence. Deterministic detection
 * runs over the whole retained text in the parent worker (issue #191), so this
 * cap is purely about what we store for the diff/file viewer. A finding past
 * this bound is surfaced in the UI's out-of-sample banner rather than pinned to
 * a hunk.
 */
export const SCAN_FILE_SAMPLE_LIMIT = 128 * 1024;

/**
 * Per-file text-sample cap the sandbox applies to a *baseline* (already
 * published, previous-version) artifact, before its files cross the wire.
 *
 * It is deliberately NOT applied to the staged/reviewed side: rules scan the
 * whole retained body there, and clipping the scanned text is exactly the
 * truncation hole that lets a payload hide past a fixed window (issue #191).
 * The baseline side feeds only line-level diff context, the recomputed baseline
 * finding fingerprints, and AI diff context — every one of which degrades in
 * the fail-safe direction when a baseline body is short: less baseline evidence
 * means *more* findings classified as release deltas, never fewer. Baseline text
 * is also never persisted (the UI's "previous" pane is served by the separate
 * `/compare` path), so this cap is invisible downstream.
 *
 * Sized at 8x `SCAN_FILE_SAMPLE_LIMIT` so it stays far above the sample any
 * surface actually displays, while bounding what a single enormous bundled file
 * on the baseline side can cost in wire bytes and parent-side memory. Manifest
 * files are exempt in the parser — manifest diffing is structural.
 */
export const BASELINE_TEXT_SAMPLE_LIMIT = 8 * SCAN_FILE_SAMPLE_LIMIT;
