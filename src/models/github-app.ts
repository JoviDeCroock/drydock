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

export interface GithubAppConfigState {
  configured: boolean;
  appSlug?: string;
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
      try {
        const data = await apiFetch<GithubAppConfigState>("/api/v1/github-app/config");
        config.value = data;
      } catch (err) {
        error.value = errorMessage(err);
        config.value = { configured: false };
      } finally {
        configLoaded.value = true;
      }
    },

    async loadInstallations(): Promise<void> {
      try {
        const data = await apiFetch<{ installations: PublicGithubAppInstallation[] }>(
          "/api/v1/github-app/installations",
        );
        installations.value = data.installations;
      } catch (err) {
        error.value = errorMessage(err);
        installations.value = [];
      } finally {
        installationsLoaded.value = true;
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
          config.value = { configured: false };
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
