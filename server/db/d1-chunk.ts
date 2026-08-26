/**
 * D1 statement sizing.
 *
 * D1 caps bound parameters per statement, so any multi-row insert has to be
 * split into batches that fit. Sizing lives here rather than at each call site
 * so the cap is stated once.
 */

const D1_MAX_BOUND_PARAMETERS = 100;

export function chunkForD1<T>(rows: T[], columnsPerRow: number, reservedParameters = 0): T[][] {
  if (!rows.length) return [];
  const chunkSize = Math.max(
    1,
    Math.floor((D1_MAX_BOUND_PARAMETERS - reservedParameters) / columnsPerRow),
  );
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    chunks.push(rows.slice(i, i + chunkSize));
  }
  return chunks;
}
