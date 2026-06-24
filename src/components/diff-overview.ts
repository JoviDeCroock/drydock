import { maxSeverity, severityGroup, type SeverityGroup } from "./diff-annotations";

export type DiffOverviewTone = "added" | "removed" | SeverityGroup;

export interface DiffOverviewMarker {
  key: string;
  kind: "change" | "finding";
  tone: DiffOverviewTone;
  topPercent: number;
  heightPercent: number;
}

export interface DiffOverviewRow {
  tone: "added" | "removed" | "unchanged";
  line: number | null;
}

interface Region {
  kind: DiffOverviewMarker["kind"];
  tone: DiffOverviewTone;
  start: number;
  end: number;
}

const MIN_CHANGE_HEIGHT_PERCENT = 1.4;
const MIN_FINDING_HEIGHT_PERCENT = 1.8;

export function diffOverviewMarkers<T extends { severity: string }>(
  rows: readonly DiffOverviewRow[],
  pinnedFindings: ReadonlyMap<number, readonly T[]>,
): DiffOverviewMarker[] {
  return [
    ...changeRegions(rows).map((region, index) =>
      markerForRegion(region, rows.length, index, MIN_CHANGE_HEIGHT_PERCENT),
    ),
    ...findingRegions(rows, pinnedFindings).map((region, index) =>
      markerForRegion(region, rows.length, index, MIN_FINDING_HEIGHT_PERCENT),
    ),
  ];
}

function changeRegions(rows: readonly DiffOverviewRow[]): Region[] {
  const regions: Region[] = [];
  let current: Region | null = null;
  rows.forEach((row, index) => {
    if (row.tone === "unchanged") {
      current = null;
      return;
    }
    if (current && current.tone === row.tone && current.end === index - 1) {
      current.end = index;
      return;
    }
    current = { kind: "change", tone: row.tone, start: index, end: index };
    regions.push(current);
  });
  return regions;
}

function findingRegions<T extends { severity: string }>(
  rows: readonly DiffOverviewRow[],
  pinnedFindings: ReadonlyMap<number, readonly T[]>,
): Region[] {
  const regions: Region[] = [];
  let current: Region | null = null;
  rows.forEach((row, index) => {
    const findings = typeof row.line === "number" ? pinnedFindings.get(row.line) : undefined;
    const severity = maxSeverityInFindings(findings);
    if (severity === null) {
      current = null;
      return;
    }
    const tone = severityGroup(severity);
    if (current && current.tone === tone && current.end === index - 1) {
      current.end = index;
      return;
    }
    current = { kind: "finding", tone, start: index, end: index };
    regions.push(current);
  });
  return regions;
}

function maxSeverityInFindings<T extends { severity: string }>(
  findings: readonly T[] | undefined,
): string | null {
  if (!findings) return null;
  let severity: string | null = null;
  for (const finding of findings) severity = maxSeverity(severity, finding.severity);
  return severity;
}

function markerForRegion(
  region: Region,
  rowCount: number,
  index: number,
  minHeightPercent: number,
): DiffOverviewMarker {
  const total = Math.max(1, rowCount);
  const naturalHeight = ((region.end - region.start + 1) / total) * 100;
  const heightPercent = Math.min(100, Math.max(minHeightPercent, naturalHeight));
  const topPercent = Math.min(100 - heightPercent, (region.start / total) * 100);
  return {
    key: `${region.kind}-${region.tone}-${region.start}-${region.end}-${index}`,
    kind: region.kind,
    tone: region.tone,
    topPercent,
    heightPercent,
  };
}
