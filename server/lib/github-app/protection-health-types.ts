export type ProtectionHealthStatus = "protected" | "at_risk" | "unknown";
export interface ProtectionHealthCheck {
  id: string;
  label: string;
  status: "passed" | "failed" | "unknown";
  detail: string;
}
export interface ProtectionHealthSnapshot {
  defaultBranch: string | null;
  checks: ProtectionHealthCheck[];
}
export interface ProtectionHealthTarget extends ProtectionHealthSnapshot {
  releaseTargetId: string;
  repositoryFullName: string;
  environment: string;
  status: ProtectionHealthStatus;
  checkedAt: string | null;
  stale: boolean;
  scope: "mapped_environment_and_default_branch";
}
export const PROTECTION_HEALTH_FRESH_MS = 60 * 60 * 1000;
export const PROTECTION_HEALTH_INTERVAL_MS = 15 * 60 * 1000;
export const PROTECTION_HEALTH_LEASE_MS = 3 * 60 * 1000;
export function protectionHealthStatus(checks: ProtectionHealthCheck[]): ProtectionHealthStatus {
  if (checks.some((check) => check.status === "failed")) return "at_risk";
  return checks.length > 0 && checks.every((check) => check.status === "passed")
    ? "protected"
    : "unknown";
}
