import type { FileRecord, PackageJsonSummary } from "../../server/lib/review";
import type { ScanResult } from "../../server/types";

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
  cachedAt?: string;
}

export interface ScanCompareFileResponse {
  version: string;
  file: FileRecord;
}

export interface ScanListItem {
  id: string;
  stageId: string;
  organizationId?: string | null;
  ownerUserId?: string | null;
  packageName: string | null;
  stagedVersion: string | null;
  previousVersion: string | null;
  risk: string;
  status: string;
  reportVersion?: number | null;
  reportDigest?: string | null;
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
    startedAt?: string | number | Date | null;
    completedAt?: string | number | Date | null;
  };
  files: Array<{
    id: string;
    scanId: string;
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
    source: string;
  }>;
}

export async function runScan(stageId: string): Promise<ScanResult> {
  return apiFetch<ScanResult>("/api/v1/scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stageId }),
  });
}

export async function createScan(
  stageId: string,
): Promise<{ scan: ScanListItem; queued: boolean }> {
  return apiFetch<{ scan: ScanListItem; queued: boolean }>("/api/v1/scans", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stageId }),
  });
}

export async function listScans(): Promise<ScanListItem[]> {
  const data = await apiFetch<{ scans: ScanListItem[] }>("/api/v1/scans");
  return data.scans;
}

export async function getScan(
  id: string,
  options: { poll?: boolean } = {},
): Promise<PersistedScanDetail> {
  const suffix = options.poll ? "?poll=1" : "";
  return apiFetch<PersistedScanDetail>(`/api/v1/scans/${encodeURIComponent(id)}${suffix}`);
}

export async function getScanVersions(id: string): Promise<ScanVersionsResponse> {
  return apiFetch<ScanVersionsResponse>(`/api/v1/scans/${encodeURIComponent(id)}/versions`);
}

export async function getScanCompare(id: string, version: string): Promise<ScanCompareResponse> {
  const query = `?version=${encodeURIComponent(version)}`;
  return apiFetch<ScanCompareResponse>(`/api/v1/scans/${encodeURIComponent(id)}/compare${query}`);
}

export async function getScanCompareFile(
  id: string,
  version: string,
  path: string,
): Promise<ScanCompareFileResponse> {
  const query = `?version=${encodeURIComponent(version)}&path=${encodeURIComponent(path)}`;
  return apiFetch<ScanCompareFileResponse>(
    `/api/v1/scans/${encodeURIComponent(id)}/compare/file${query}`,
  );
}

async function apiFetch<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    credentials: "same-origin",
    headers: { accept: "application/json", ...init?.headers },
    ...init,
  });
  const data = (await res.json().catch(() => null)) as
    | (Partial<T> & { error?: string; detail?: string })
    | null;
  if (!res.ok) {
    if (res.status === 401) throw new Error("Please sign in to continue.");
    const detail = typeof data?.detail === "string" ? `: ${data.detail}` : "";
    throw new Error(`${data?.error || "request failed"}${detail}`);
  }
  return data as T;
}
