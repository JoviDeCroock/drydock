import { ApiError, apiFetch, apiJson } from "./api";

export type WorkflowGateStatus = "pending" | "approved" | "rejected" | "errored";
export type WorkflowGateDecision = "approved" | "rejected";
export type GatePackageDecision = "publish" | "no_publish";

export interface GatePackageScan {
  scanId: string;
  packageName: string | null;
  version: string | null;
  status: string;
  releaseRisk: string | null;
  decision: GatePackageDecision | null;
}

export interface PublicWorkflowGate {
  id: string;
  organizationId: string;
  releaseTargetId: string;
  repositoryFullName: string;
  environment: string;
  runId: number;
  status: WorkflowGateStatus;
  decision: WorkflowGateDecision | null;
  decisionComment: string | null;
  reportUrl: string | null;
  scanId: string | null;
  failureReason: string | null;
  organizationRequiresTwoFactor: boolean;
  packages: GatePackageScan[];
  requestedAt: string;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function getWorkflowGateByScan(scanId: string): Promise<PublicWorkflowGate | null> {
  try {
    const data = await apiFetch<{ gate: PublicWorkflowGate }>(
      `/api/v1/github-app/workflow-gates/by-scan/${encodeURIComponent(scanId)}`,
    );
    return data.gate;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export function decideWorkflowGate(
  gateId: string,
  scanId: string,
  decision: WorkflowGateDecision,
  comment: string | null,
  totpCode?: string | null,
): Promise<{ gate: PublicWorkflowGate }> {
  const payload: {
    scanId: string;
    decision: WorkflowGateDecision;
    comment?: string;
    totpCode?: string;
  } = { scanId, decision };
  if (comment) payload.comment = comment;
  if (totpCode) payload.totpCode = totpCode;
  return apiJson<{ gate: PublicWorkflowGate }>(
    `/api/v1/github-app/workflow-gates/${encodeURIComponent(gateId)}/decision`,
    payload,
  ).catch((err) => {
    if (err instanceof ApiError && err.status === 401) {
      if (err.code === "two_factor_required") {
        throw new ApiError(
          "Enter your authentication code to decide this gate.",
          401,
          err.detail,
          err.code,
        );
      }
      if (err.code === "two_factor_invalid") {
        throw new ApiError("That authentication code is invalid.", 401, err.detail, err.code);
      }
    }
    if (
      err instanceof ApiError &&
      err.status === 403 &&
      err.code === "two_factor_enrollment_required"
    ) {
      throw new ApiError(
        "Your organization requires two-factor authentication to decide releases. Enable it in Settings, then try again.",
        403,
        err.detail,
        err.code,
      );
    }
    throw err;
  });
}

export function retryWorkflowGate(gateId: string): Promise<{ gate: PublicWorkflowGate }> {
  return apiJson<{ gate: PublicWorkflowGate }>(
    `/api/v1/github-app/workflow-gates/${encodeURIComponent(gateId)}/retry`,
    {},
  );
}
