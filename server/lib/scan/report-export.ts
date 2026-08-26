import { isRecord } from "../platform/guards";
import type { getScan } from "../../db/scans";
import { parsePersistedAiReview } from "../ai-review/contract";
import { displayedAiResult } from "../ai-review/types";
import { normalizeIntentEnvelope } from "../intent-envelope";
import { normalizeCapabilityDelta } from "../review";
import { normalizeReleaseConsistency } from "./release-memory";
import type { ReleaseProvenance, ReleaseProvenanceArtifact } from "../ecosystems/package-adapter";
import { isEcosystemId } from "../ecosystems/labels";
import { parseStagedArtifactIntegrity } from "../ecosystems/artifact-integrity";

// A persisted scan detail, as returned by getScan (never null at the call site).
type ScanDetail = NonNullable<Awaited<ReturnType<typeof getScan>>>;

interface ReportExportFilenameInput {
  id: string;
  packageName: string | null;
  stagedVersion: string | null;
}

// Schema tag for the exported report document. Bump the suffix when the export
// shape changes in a way consumers must branch on.
//
// v2 drops `releaseConsistency.priorScanId` and `releaseConsistency.decidedAt`
// (see `exportReleaseConsistency`). Those are removals from the authenticated
// `report.json` contract as much as from the public one, so they take the bump
// with them: the export is the signing boundary, and a consumer that pinned v1
// must not silently receive a document missing a field it read.
export const REPORT_EXPORT_SCHEMA = "drydock.report.v2";

// Build a self-contained, archivable view of a completed review from the data
// already persisted for it: provenance metadata, package/baseline identity, the
// risk summary, the manifest and file diffs, and the deterministic findings.
//
// This is the persisted *record*, not a re-derivation of the digested payload —
// the stored report digest is carried through for reference, but reproducing it
// byte-for-byte from the database is deliberately out of scope here.
export function buildReportExport(detail: ScanDetail) {
  const { scan } = detail;
  const summary = isRecord(scan.summaryJson) ? scan.summaryJson : {};
  return {
    schema: REPORT_EXPORT_SCHEMA,
    report: summary.report ?? null,
    scan: {
      id: scan.id,
      stageId: scan.stageId,
      status: scan.status,
      source: scan.source,
      risk: scan.risk,
      decision: scan.decision ?? null,
      createdAt: toIso(scan.createdAt),
      completedAt: toIso(scan.completedAt),
    },
    package: {
      name: scan.packageName ?? null,
      stagedVersion: scan.stagedVersion ?? null,
      previousVersion: scan.previousVersion ?? null,
    },
    // What the registry did with this version after the review, distinct from
    // `scan.decision`, which is what the organization decided about it. Additive
    // and optional: null whenever the lookup never ran, was not supported, or
    // could not be authorized — never as a statement about the release.
    registryStatus: exportRegistryStatus(scan),
    baseline: summary.baseline ?? null,
    safety: summary.safety ?? null,
    // Byte-continuity record: the reviewed artifacts + the digests recomputed
    // from the immutable release bytes, so a consumer can verify the published
    // wheel/sdist/tarball matches what Drydock reviewed. Workflow-gate reviews
    // only; null for staged-publish scans.
    provenance: extractProvenance(summary.stagedPublish),
    // Advisory source-binding tier (attested / declared / absent). Additive and
    // optional: scans persisted before the envelope existed export `null`.
    intentEnvelope: normalizeIntentEnvelope(summary.intentEnvelope),
    // Advisory per-side capability projection and delta. Additive and
    // optional: scans persisted before the projection existed export `null`.
    capabilities: normalizeCapabilityDelta(summary.capabilities),
    // Staged-artifact byte-verification verdict. Null for workflow gates,
    // legacy scans, and malformed persisted data.
    artifactIntegrity: extractArtifactIntegrity(summary.stagedPublish),
    aiReview: extractAiReview(scan.aiJson),
    riskSummary: detail.riskSummary ?? null,
    // Advisory release-memory signal. Additive + optional: scans that predate
    // the field (or persisted a malformed blob) export null.
    releaseConsistency: exportReleaseConsistency(summary.releaseConsistency),
    packageJsonDiff: summary.packageJsonDiff ?? null,
    diff: summary.diff ?? null,
    // Deterministic findings only. A completed AI review's findings are carried
    // by `aiReview.findings` above; including the persisted `source: "ai"` rows
    // here too would double-count them in this array and break the invariant
    // that every entry has a ruleId/ruleVersion. Keeps `drydock.report.v2`'s
    // findings[] meaning stable across the persistence change.
    findings: detail.findings
      .filter((finding) => finding.source !== "ai")
      .sort(compareFindings)
      .map((finding) => ({
        severity: finding.severity,
        file: finding.file,
        line: finding.line ?? null,
        ruleId: finding.ruleId ?? null,
        ruleVersion: finding.ruleVersion ?? null,
        source: finding.source,
        diffStatus: finding.diffStatus ?? null,
        releaseDelta: finding.releaseDelta ?? null,
        evidence: finding.evidence,
        reason: finding.reason,
      })),
  };
}

function exportRegistryStatus(scan: ScanDetail["scan"]) {
  const status = scan.registryVersionStatus;
  if (typeof status !== "string" || !status) return null;
  return { status, observedAt: toIso(scan.registryVersionStatusAt) };
}

export type ReportExportDocument = ReturnType<typeof buildReportExport>;

// Serialize the export with stable key ordering so the same evidence always
// produces byte-identical output — the property two report artifacts need to be
// comparable, and a prerequisite for signing later.
export function serializeReportExport(detail: ScanDetail): string {
  return serializeReportExportDocument(buildReportExport(detail));
}

// Serialize an already-built export. The attestation route needs the document
// *and* its bytes: anything it asserts about the report has to be read off the
// same object that produced the digest it signs, or the two can disagree inside
// a signed envelope (they did — `findingCount` counted AI findings the
// document's `findings[]` deliberately excludes).
export function serializeReportExportDocument(document: ReportExportDocument): string {
  return stableStringify(document);
}

export function reportExportFilename(scan: ReportExportFilenameInput): string {
  const packageName = filenameSegment(scan.packageName);
  const version = filenameSegment(scan.stagedVersion);
  if (packageName && version) return `drydock-${packageName}-${version}.json`;
  return `drydock-report-${filenameSegment(scan.id) || "scan"}.json`;
}

function compareFindings(
  a: ScanDetail["findings"][number],
  b: ScanDetail["findings"][number],
): number {
  return (
    cmp(a.file, b.file) ||
    cmp(a.ruleId ?? "", b.ruleId ?? "") ||
    (a.line ?? 0) - (b.line ?? 0) ||
    cmp(a.severity, b.severity)
  );
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => cmp(a, b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "string") return value;
  return null;
}

// The export drops `priorScanId` and `decidedAt`: both describe a *prior* scan
// the org never chose to share, and these bytes are served verbatim on the
// public report route. `decidedAt` is the sharper of the two — a precise
// timestamp of an internal review decision on an unshared release. What stays
// (`status`, the finding counts, `newFindings`) describes this scan's delta
// against that history, which is the signal the report is making.
function exportReleaseConsistency(raw: unknown) {
  const consistency = normalizeReleaseConsistency(raw);
  if (!consistency) return null;
  const { priorScanId: _priorScanId, decidedAt: _decidedAt, ...exported } = consistency;
  return exported;
}

// Pull the provenance block out of the persisted, adapter-shaped staged details.
// The shape is re-validated rather than trusted so a malformed or pre-provenance
// record exports as `null` instead of leaking partial data.
function extractProvenance(stagedPublish: unknown): ReleaseProvenance | null {
  if (!isRecord(stagedPublish)) return null;
  const provenance = stagedPublish.provenance;
  if (!isRecord(provenance)) return null;
  const { ecosystem, mode, artifacts } = provenance;
  if (typeof ecosystem !== "string" || !isEcosystemId(ecosystem) || mode !== "workflow_gate") {
    return null;
  }
  if (!Array.isArray(artifacts)) return null;
  const mapped: ReleaseProvenanceArtifact[] = [];
  for (const artifact of artifacts) {
    if (!isRecord(artifact)) return null;
    const { path, kind, sha256 } = artifact;
    if (typeof path !== "string" || typeof sha256 !== "string") return null;
    if (kind === "tarball" || kind === "wheel" || kind === "sdist" || kind === "vsix") {
      mapped.push({ path, kind, sha256 });
      continue;
    }
    return null;
  }
  if (!mapped.length) return null;
  return { ecosystem, mode, artifacts: mapped };
}

function extractArtifactIntegrity(stagedPublish: unknown) {
  if (!isRecord(stagedPublish)) return null;
  return parseStagedArtifactIntegrity(stagedPublish.artifactIntegrity);
}

// Route through the display helper so invalid/unavailable fallbacks do not
// leak the persisted `low` / `not_assessed` placeholders.
function extractAiReview(aiJson: unknown) {
  const review = parsePersistedAiReview(aiJson);
  if (!review) return null;
  const displayed = displayedAiResult(review);
  if (!displayed) return null;
  if (displayed.kind === "complete") {
    return {
      status: "complete",
      model: displayed.model,
      summary: displayed.summary,
      risk: displayed.risk,
      releaseAssessment: displayed.releaseAssessment,
      requiresManualReview: displayed.requiresManualReview,
      findings: displayed.findings.map((finding) => ({
        severity: finding.severity,
        file: finding.file,
        evidence: finding.evidence,
        reason: finding.reason,
        recommendation: finding.recommendation,
      })),
    };
  }
  return {
    status: displayed.status,
    model: displayed.model,
    summary: displayed.summary,
    risk: null,
    releaseAssessment: null,
    requiresManualReview: false,
    findings: [],
  };
}

function filenameSegment(value: string | null | undefined): string | null {
  const segment = value
    ?.trim()
    .replace(/[/\\]+/g, "-")
    .replace(/[^A-Za-z0-9@._+-]+/g, "-");
  const trimmed = segment?.replace(/-+/g, "-").replace(/^-|-$/g, "");
  return trimmed || null;
}
