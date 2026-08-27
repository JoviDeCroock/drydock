import { computed, createModel, signal } from "@preact/signals";
import { ApiError, apiFetch, apiJson, errorMessage } from "./api";

export type InstallationStatus = "active" | "suspended" | "uninstalled";

export interface PublicGithubAppInstallation {
  id: string;
  organizationId: string;
  installationId: string;
  accountLogin: string;
  accountType: string;
  targetType: string;
  status: InstallationStatus;
  installedAt: string;
  createdAt: string;
  updatedAt: string;
}

type WorkflowGateStatus = "pending" | "approved" | "rejected" | "errored";
export type WorkflowGateDecision = "approved" | "rejected";
export type GatePackageDecision = "publish" | "no_publish";

// One entry per distinct package the gated release publishes. A monorepo fans
// out into several; the gate releases only once every package is approved.
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
  // Org policy: every member must step up with a fresh code to decide this gate,
  // and a member who has not enrolled in 2FA cannot decide it at all.
  organizationRequiresTwoFactor: boolean;
  packages: GatePackageScan[];
  requestedAt: string;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Returns null when no gate is mapped to the scan (404) so callers can treat a
// plain manual/auto-discovery scan and a not-yet-loaded gate the same way.
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

// Records a decision for a single package of the gate (`scanId`). The gate only
// finalizes — releasing or blocking the held GitHub job — once every package is
// approved, or the moment any one is rejected.
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

export interface GateSetupEcosystemOption {
  id: string;
  label: string;
}

export interface GithubAppConfigState {
  configured: boolean;
  appSlug?: string;
  gateSetupEcosystems: GateSetupEcosystemOption[];
}

export type GithubAppInstallStatus = "idle" | "starting" | "completing" | "loading";

export type GithubAppCallbackErrorCode =
  | "github_app_not_configured"
  | "installation_missing"
  | "installation_inactive"
  | "installation_not_authorized"
  | "invalid_input"
  | "state_invalid"
  | "state_org_mismatch"
  | "state_user_mismatch"
  | "installation_not_active"
  | "unknown";

export interface CallbackError {
  code: GithubAppCallbackErrorCode;
  message: string;
}

export interface CallbackQuery {
  state: string;
  code: string;
  installationId: string;
  setupAction: string;
}

export const GithubAppModel = createModel(() => {
  const config = signal<GithubAppConfigState | null>(null);
  const installations = signal<PublicGithubAppInstallation[]>([]);
  const status = signal<GithubAppInstallStatus>("idle");
  const error = signal<string | null>(null);
  const callbackError = signal<CallbackError | null>(null);
  const lastLinked = signal<PublicGithubAppInstallation | null>(null);
  const configLoaded = signal(false);
  const installationsLoaded = signal(false);
  // Settings reloads config and installations on every organization switch. A slower response from the previous organization must
  // not land on top of the new one, so each loader only commits the newest call.
  let configRequestId = 0;
  let installationsRequestId = 0;

  const busy = computed(() => status.value !== "idle");
  const notConfigured = computed(() => config.value?.configured === false);
  const loaded = computed(() => configLoaded.value && installationsLoaded.value);
  return {
    config,
    installations,
    status,
    error,
    callbackError,
    lastLinked,
    configLoaded,
    installationsLoaded,
    busy,
    notConfigured,
    loaded,

    async loadConfig(): Promise<void> {
      const requestId = ++configRequestId;
      try {
        const data = await apiFetch<GithubAppConfigState>("/api/v1/github-app/config");
        if (requestId !== configRequestId) return;
        config.value = data;
      } catch (err) {
        if (requestId !== configRequestId) return;
        error.value = errorMessage(err);
        config.value = { configured: false, gateSetupEcosystems: [] };
      } finally {
        if (requestId === configRequestId) configLoaded.value = true;
      }
    },

    async loadInstallations(): Promise<void> {
      const requestId = ++installationsRequestId;
      try {
        const data = await apiFetch<{ installations: PublicGithubAppInstallation[] }>(
          "/api/v1/github-app/installations",
        );
        if (requestId !== installationsRequestId) return;
        installations.value = data.installations;
      } catch (err) {
        if (requestId !== installationsRequestId) return;
        error.value = errorMessage(err);
        installations.value = [];
      } finally {
        if (requestId === installationsRequestId) installationsLoaded.value = true;
      }
    },

    async startInstall(): Promise<void> {
      status.value = "starting";
      error.value = null;
      try {
        const data = await apiJson<{
          installUrl: string;
          state: string;
          expiresInSeconds: number;
        }>("/api/v1/github-app/install", {});
        window.location.assign(data.installUrl);
      } catch (err) {
        if (err instanceof ApiError && err.code === "github_app_not_configured") {
          config.value = { configured: false, gateSetupEcosystems: [] };
          error.value =
            "GitHub App is not configured yet on this Drydock instance. Ask the operator to add the GitHub App secrets.";
        } else {
          error.value = errorMessage(err);
        }
        status.value = "idle";
      }
    },

    async completeInstall(query: CallbackQuery): Promise<PublicGithubAppInstallation | null> {
      status.value = "completing";
      callbackError.value = null;
      error.value = null;
      lastLinked.value = null;
      try {
        const data = await apiJson<{ installation: PublicGithubAppInstallation }>(
          "/api/v1/github-app/install/callback",
          query,
        );
        lastLinked.value = data.installation;
        const existing = installations.peek();
        installations.value = [
          data.installation,
          ...existing.filter((row) => row.id !== data.installation.id),
        ];
        return data.installation;
      } catch (err) {
        callbackError.value = mapCallbackError(err);
        return null;
      } finally {
        status.value = "idle";
      }
    },

    reset() {
      error.value = null;
      callbackError.value = null;
      lastLinked.value = null;
    },
  };
});

function mapCallbackError(err: unknown): CallbackError {
  if (err instanceof ApiError) {
    if (err.code === "github_app_not_configured") {
      return {
        code: "github_app_not_configured",
        message:
          "GitHub App is not configured yet on this Drydock instance. Ask the operator to add the GitHub App secrets.",
      };
    }
    if (err.code) {
      return { code: err.code as GithubAppCallbackErrorCode, message: err.message };
    }
    if (err.status === 400 && /state token/i.test(err.message)) {
      return { code: "state_invalid", message: err.message };
    }
    if (err.status === 403 && /organization/i.test(err.message)) {
      return { code: "state_org_mismatch", message: err.message };
    }
    if (err.status === 403 && /user/i.test(err.message)) {
      return { code: "state_user_mismatch", message: err.message };
    }
    if (err.status === 409) {
      return { code: "installation_not_active", message: err.message };
    }
    return { code: "unknown", message: err.message };
  }
  return { code: "unknown", message: errorMessage(err) };
}
