import { computed, createModel, signal } from "@preact/signals";
import { apiFetch, apiJson, errorMessage } from "./api";
import { busySignal, runAction } from "./async-action";

export interface PublicNpmConnection {
  id: string;
  organizationId: string;
  registryUrl: string;
  label: string;
  tokenFingerprint: string;
  tokenLast4: string | null;
  validationStatus: string;
  capabilitiesJson: unknown;
  validatedAt: string | number | Date | null;
  lastUsedAt: string | number | Date | null;
  createdByUserId: string | null;
  createdAt: string | number | Date;
  updatedAt: string | number | Date;
}

export interface NpmCredentialValidation {
  ok: boolean;
  status: "valid" | "invalid";
  capabilities: {
    registryAuth: boolean;
    stagedTarballAccess?: boolean;
    whoami?: string | null;
    registryUrl: string;
    stageId?: string;
    status?: number;
    stagedTarballStatus?: number;
    detail?: string;
    stagedTarballDetail?: string;
  };
}

export type NpmConnectionStatus = "idle" | "saving" | "validating" | "deleting";

const DEFAULT_LABEL = "npm registry";
const DEFAULT_REGISTRY = "https://registry.npmjs.org";

export const NpmConnectionModel = createModel(() => {
  const connection = signal<PublicNpmConnection | null>(null);
  const loaded = signal(false);
  const status = signal<NpmConnectionStatus>("idle");
  const error = signal<string | null>(null);

  const token = signal("");
  const label = signal(DEFAULT_LABEL);
  const registry = signal(DEFAULT_REGISTRY);
  const validationStageId = signal("");

  const busy = busySignal(status);
  const isConnected = computed(() => connection.value !== null);
  const validated = computed(() => connection.value?.validationStatus === "valid");

  return {
    connection,
    loaded,
    status,
    error,
    token,
    label,
    registry,
    validationStageId,
    busy,
    isConnected,
    validated,

    async load(): Promise<void> {
      try {
        const data = await apiFetch<{ connection: PublicNpmConnection | null }>(
          "/api/v1/npm-connection",
        );
        this.applyConnection(data.connection);
      } catch {
        // Keep the dashboard usable; scan creation enforces the requirement.
      } finally {
        this.loaded.value = true;
      }
    },

    applyConnection(next: PublicNpmConnection | null) {
      this.connection.value = next;
      if (next) {
        this.label.value = next.label;
        this.registry.value = next.registryUrl;
      } else {
        this.label.value = DEFAULT_LABEL;
        this.registry.value = DEFAULT_REGISTRY;
      }
      this.token.value = "";
      this.validationStageId.value = "";
    },

    async save(): Promise<void> {
      const trimmedToken = this.token.value.trim();
      if (!trimmedToken) return;
      this.status.value = "saving";
      this.error.value = null;
      try {
        const data = await saveNpmConnection({
          token: trimmedToken,
          label: this.label.value.trim() || DEFAULT_LABEL,
          registryUrl: this.registry.value.trim() || DEFAULT_REGISTRY,
        });
        this.applyConnection(data.connection);
        if (data.connection) {
          this.status.value = "validating";
          const validation = await validateNpmConnection();
          this.applyConnection(validation.connection);
          if (!validation.validation.ok) {
            this.error.value = "Saved token, but npm validation reported invalid access.";
          }
        }
      } catch (err) {
        this.error.value = errorMessage(err);
        await this.load();
      } finally {
        this.status.value = "idle";
      }
    },

    async validate(): Promise<void> {
      const result = await runAction({
        status: this.status,
        error: this.error,
        pending: "validating",
        run: async () => {
          const stageId = this.validationStageId.value.trim() || undefined;
          const data = await validateNpmConnection(stageId);
          this.applyConnection(data.connection);
          if (!data.validation.ok) {
            this.error.value = "Npm validation reported invalid access.";
          }
          return true;
        },
      });
      if (result === undefined) await this.load();
    },

    async remove(): Promise<void> {
      await runAction({
        status: this.status,
        error: this.error,
        pending: "deleting",
        run: async () => {
          await apiFetch<{ ok: boolean }>("/api/v1/npm-connection", { method: "DELETE" });
          this.connection.value = null;
          this.token.value = "";
        },
      });
    },
  };
});

function saveNpmConnection(input: {
  token: string;
  label: string;
  registryUrl: string;
}): Promise<{ connection: PublicNpmConnection | null }> {
  return apiJson<{ connection: PublicNpmConnection | null }>("/api/v1/npm-connection", input);
}

function validateNpmConnection(stageId?: string): Promise<{
  validation: NpmCredentialValidation;
  connection: PublicNpmConnection | null;
}> {
  return apiJson<{
    validation: NpmCredentialValidation;
    connection: PublicNpmConnection | null;
  }>("/api/v1/npm-connection/validate", { stageId });
}
