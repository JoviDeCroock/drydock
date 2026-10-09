const SCAN_SOURCE_LABELS: Readonly<Record<string, string>> = {
  // "manual" covers every review a person started here, including the staged
  // releases "Check npm" finds; the scheduled sweep is the one that runs alone.
  manual: "started in Drydock",
  auto_discovery: "found by scheduled npm check",
  workflow_gate: "workflow gate",
  published: "published release",
};

/**
 * How a review started, in reader words, shared by every list of reviews so
 * the dashboard and the package view never name the same origin two ways. An
 * unknown source falls through as its stored value rather than disappearing.
 */
export function scanSourceLabel(source: string | null | undefined): string {
  const value = source ?? "manual";
  return Object.hasOwn(SCAN_SOURCE_LABELS, value) ? SCAN_SOURCE_LABELS[value] : value;
}
