import type { ScanResult } from "../../server/types";

export async function runScan(stageId: string): Promise<ScanResult> {
  const res = await fetch("/api/v1/scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stageId }),
  });
  const data = (await res.json()) as Partial<ScanResult> & { error?: string; detail?: string };
  if (!res.ok) {
    const detail = typeof data.detail === "string" ? `: ${data.detail}` : "";
    throw new Error(`${data.error || "scan failed"}${detail}`);
  }
  return data as ScanResult;
}
