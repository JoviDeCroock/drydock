/**
 * The scan HTTP surface: wire shapes and the calls that produce them.
 *
 * Everything the dashboard knows about a scan arrives through here. Kept apart
 * from the models so the response shapes can be read without wading through
 * polling and selection state.
 */
import type {
  FileRecord,
  FindingDiffAnnotation,
  FindingDiffStatus,
  PackageJsonSummary,
} from "../../server/lib/review";
import { settledRegistryStatus, type SettledRegistryStatus } from "../lib/npm-stage-follow-up";
import { apiFetch, apiJson } from "./api";

export interface ScanVersionsResponse {
  packageName: string | null;
  stagedVersion: string | null;
  defaultPreviousVersion: string | null;
  versions: Array<{ version: string; distTags: string[]; publishedAt?: string }>;
}

export interface ScanCompareResponse {
  version: string;
  files: FileRecord[];
  packageJson: PackageJsonSummary | null;
  findingAnnotations?: Array<{ id: string } & FindingDiffAnnotation>;
  cachedAt?: string;
}

export interface ScanCompareFileResponse {
  version: string;
  file: FileRecord;
}

export interface ScanStatusResponse {
  scan: PersistedScanDetail["scan"];
}

export interface ScanFileResponse {
  file: PersistedScanDetail["files"][number];
}

export type ScanDecision = "publish" | "no_publish";
export type ScanDecisionFilter =
  | "undecided"
  | "published_without_decision"
  | "publish"
  | "no_publish"
  | "all";

interface ScanRiskSummary {
  artifactRisk: string;
  releaseRisk: string;
  contextRisk: string;
  releaseFindingCount: number;
  contextFindingCount: number;
  unknownFindingCount: number;
  /** Optional: absent on scans persisted before release memory affected scoring. */
  priorApprovedContextFindingCount?: number;
}

export interface ScanListItem {
  id: string;
  stageId: string;
  source?: string | null;
  organizationId?: string | null;
  ownerUserId?: string | null;
  packageName: string | null;
  stagedVersion: string | null;
  previousVersion: string | null;
  risk: string;
  status: string;
  decision?: ScanDecision | string | null;
  decisionReason?: string | null;
  decidedByUserId?: string | null;
  decidedAt?: string | number | Date | null;
  changedFileCount?: number;
  findingCount?: number;
  riskSummary?: ScanRiskSummary | null;
  reportVersion?: number | null;
  reportDigest?: string | null;
  /** Registry captured when the staged release was submitted. */
  registryUrl?: string | null;
  /** npm's lifecycle status for this exact staged version, or null if unknown. */
  registryVersionStatus?: string | null;
  registryVersionStatusAt?: string | number | Date | null;
  /** Settled npm outcome derived from lifecycle status or a terminal scan failure. */
  registryReleaseOutcome?: SettledRegistryStatus | null;
  /** Set when a newer stage reused this registry package and version. */
  registryStatusSupersededAt?: string | number | Date | null;
  startedAt?: string | number | Date | null;
  completedAt?: string | number | Date | null;
  createdAt: string | number | Date;
  updatedAt: string | number | Date;
}

export interface PersistedScanDetail {
  scan: ScanListItem & {
    summaryJson?: unknown;
    aiJson?: unknown;
    errorJson?: unknown;
    reportVersion?: number | null;
    reportDigest?: string | null;
    publicShareToken?: string | null;
    publicShareUrl?: string | null;
    publicSharedAt?: string | number | Date | null;
    publicFeedListedAt?: string | number | Date | null;
    publicShareIncludesFiles?: boolean;
    startedAt?: string | number | Date | null;
    completedAt?: string | number | Date | null;
  };
  riskSummary?: ScanRiskSummary | null;
  files: Array<{
    path: string;
    status: string;
    size: number | null;
    sha256: string | null;
    flagsJson: unknown;
    textSample: string | null;
  }>;
  findings: Array<{
    id: string;
    scanId: string;
    severity: string;
    file: string;
    evidence: string;
    reason: string;
    line?: number | null;
    source: string;
    ruleId?: string | null;
    ruleVersion?: string | null;
    diffStatus?: FindingDiffStatus;
    releaseDelta?: boolean;
  }>;
  events: Array<{
    id: string;
    organizationId: string;
    actorUserId: string | null;
    scanId: string | null;
    type: string;
    metadataJson: unknown;
    createdAt: string | number | Date;
  }>;
}

export interface ListScansResponse {
  scans: ScanListItem[];
  nextCursor: string | null;
  filter: ScanDecisionFilter;
  limit: number;
}

export function listScans(
  options: { cursor?: string | null; filter?: ScanDecisionFilter; limit?: number } = {},
): Promise<ListScansResponse> {
  const params = new URLSearchParams();
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.filter) params.set("filter", options.filter);
  if (options.limit) params.set("limit", String(options.limit));
  const qs = params.toString();
  return apiFetch<ListScansResponse>(`/api/v1/scans${qs ? `?${qs}` : ""}`);
}

/** Coordinates of a published release to review. See `published-review.ts`. */
export interface PublishedScanRequest {
  ecosystem: string;
  packageName: string;
  version: string;
  baselineVersion?: string;
}

export function createPublishedScan(
  request: PublishedScanRequest,
): Promise<{ scan: { id: string } }> {
  return apiJson<{ scan: { id: string } }>("/api/v1/scans", request);
}

export function setScanDecision(
  id: string,
  decision: ScanDecision,
  reason: string | null,
): Promise<PersistedScanDetail> {
  return apiJson<PersistedScanDetail>(`/api/v1/scans/${encodeURIComponent(id)}/decision`, {
    decision,
    reason,
  });
}

export function deleteScan(id: string): Promise<{ ok: true; id: string }> {
  return apiFetch<{ ok: true; id: string }>(`/api/v1/scans/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function getScan(
  id: string,
  options: { poll?: boolean } = {},
): Promise<PersistedScanDetail> {
  const suffix = options.poll ? "?poll=1" : "";
  return apiFetch<PersistedScanDetail>(`/api/v1/scans/${encodeURIComponent(id)}${suffix}`);
}

export function getScanStatus(id: string): Promise<ScanStatusResponse> {
  return apiFetch<ScanStatusResponse>(`/api/v1/scans/${encodeURIComponent(id)}/status`);
}

export function getScanFile(id: string, path: string): Promise<ScanFileResponse> {
  const query = `?path=${encodeURIComponent(path)}`;
  return apiFetch<ScanFileResponse>(`/api/v1/scans/${encodeURIComponent(id)}/file${query}`);
}

export function getScanVersions(id: string): Promise<ScanVersionsResponse> {
  return apiFetch<ScanVersionsResponse>(`/api/v1/scans/${encodeURIComponent(id)}/versions`);
}

export function getScanCompare(id: string, version: string): Promise<ScanCompareResponse> {
  const query = `?version=${encodeURIComponent(version)}`;
  return apiFetch<ScanCompareResponse>(`/api/v1/scans/${encodeURIComponent(id)}/compare${query}`);
}

export function getScanCompareFile(
  id: string,
  version: string,
  path: string,
): Promise<ScanCompareFileResponse> {
  const query = `?version=${encodeURIComponent(version)}&path=${encodeURIComponent(path)}`;
  return apiFetch<ScanCompareFileResponse>(
    `/api/v1/scans/${encodeURIComponent(id)}/compare/file${query}`,
  );
}

export interface PublicShareInfo {
  token: string;
  url: string;
  sharedAt: string | number | Date;
  threatFeedListedAt: string | number | Date | null;
  includesFiles: boolean;
}

export function enableScanShare(
  id: string,
  options: { threatFeed?: boolean } = {},
): Promise<{ share: PublicShareInfo }> {
  return apiJson<{ share: PublicShareInfo }>(
    `/api/v1/scans/${encodeURIComponent(id)}/share`,
    options,
  );
}

export function revokeScanShare(id: string): Promise<{ revoked: boolean }> {
  return apiFetch<{ revoked: boolean }>(`/api/v1/scans/${encodeURIComponent(id)}/share`, {
    method: "DELETE",
  });
}

export function publicReportUrl(token: string): string {
  return `${location.origin}/reports/${token}`;
}

export function publicReportAttestationUrl(token: string): string {
  return `${location.origin}/public/reports/${encodeURIComponent(token)}/attestation`;
}

export async function publicAttestationAvailable(): Promise<boolean> {
  try {
    const response = await fetch("/public/attestation-key", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export type DecisionStatus = "idle" | "saving" | "error";
export type DeleteStatus = "idle" | "deleting" | "error";

export function scanMatchesDecisionFilter(
  scan: Pick<
    ScanListItem,
    "decision" | "registryReleaseOutcome" | "registryStatusSupersededAt" | "registryVersionStatus"
  >,
  filter: ScanDecisionFilter,
): boolean {
  if (filter === "all") return true;
  const releaseOutcome =
    scan.registryReleaseOutcome ?? settledRegistryStatus(scan.registryVersionStatus);
  if (filter === "published_without_decision") {
    return (
      !scan.decision &&
      scan.registryStatusSupersededAt == null &&
      (releaseOutcome === "published" || releaseOutcome === "deleted")
    );
  }
  if (filter === "undecided") {
    return !scan.decision && scan.registryStatusSupersededAt == null && releaseOutcome === null;
  }
  return scan.decision === filter;
}
