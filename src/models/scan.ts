import type { ScanResult } from "../../server/types";

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
  createdAt: string | number | Date;
  updatedAt: string | number | Date;
}

export interface PersistedScanDetail {
  scan: ScanListItem & {
    summaryJson?: unknown;
    aiJson?: unknown;
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

export async function listScans(): Promise<ScanListItem[]> {
  const data = await apiFetch<{ scans: ScanListItem[] }>("/api/v1/scans");
  return data.scans;
}

export async function getScan(id: string): Promise<PersistedScanDetail> {
  return apiFetch<PersistedScanDetail>(`/api/v1/scans/${encodeURIComponent(id)}`);
}

async function apiFetch<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    credentials: "same-origin",
    headers: { accept: "application/json", ...init?.headers },
    ...init,
  });
  const data = (await res.json().catch(() => null)) as (Partial<T> & { error?: string; detail?: string }) | null;
  if (!res.ok) {
    if (res.status === 401) throw new Error("Please sign in to continue.");
    const detail = typeof data?.detail === "string" ? `: ${data.detail}` : "";
    throw new Error(`${data?.error || "request failed"}${detail}`);
  }
  return data as T;
}
