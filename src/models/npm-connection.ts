import { computed, createModel, signal } from "@preact/signals";
import { apiFetch } from "./api";

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

export type NpmCredentialStatus = "valid" | "invalid" | "capability_limited";

export type NpmCredentialReason =
  | "registry_auth_failed"
  | "staged_list_denied"
  | "staged_view_denied"
  | "staged_tarball_denied"
  | "no_stages_to_probe";

export interface NpmCredentialValidation {
  ok: boolean;
  status: NpmCredentialStatus;
  reasons: NpmCredentialReason[];
  capabilities: {
    registryAuth: boolean;
    stagedListAccess: boolean;
    stagedTarballAccess?: boolean;
    stagedViewAccess?: boolean;
    whoami?: string | null;
    registryUrl: string;
    stageId?: string;
    probedStageSource?: "caller" | "list";
    status?: number;
    stagedListStatus?: number;
    stagedViewStatus?: number;
    stagedTarballStatus?: number;
    detail?: string;
    stagedListDetail?: string;
    stagedViewDetail?: string;
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

  const busy = computed(() => status.value !== "idle");
  const isConnected = computed(() => connection.value !== null);
  const validated = computed(() => connection.value?.validationStatus === "valid");
  const validationState = computed<
    "missing" | "unvalidated" | "valid" | "invalid" | "capability_limited"
  >(() => {
    const next = connection.value;
    if (!next) return "missing";
    switch (next.validationStatus) {
      case "valid":
      case "invalid":
      case "capability_limited":
        return next.validationStatus;
      default:
        return "unvalidated";
    }
  });
  const validationReasons = computed<NpmCredentialReason[]>(() => {
    const caps = connection.value?.capabilitiesJson;
    if (!caps || typeof caps !== "object") return [];
    const list = (caps as { reasons?: unknown }).reasons;
    return Array.isArray(list)
      ? (list.filter((entry) => typeof entry === "string") as NpmCredentialReason[])
      : [];
  });

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
    validationState,
    validationReasons,

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
            this.error.value = "Saved token. " + describeValidationFailure(validation.validation);
          }
        }
      } catch (err) {
        this.error.value = err instanceof Error ? err.message : String(err);
        await this.load();
      } finally {
        this.status.value = "idle";
      }
    },

    async validate(): Promise<void> {
      this.status.value = "validating";
      this.error.value = null;
      try {
        const stageId = this.validationStageId.value.trim() || undefined;
        const data = await validateNpmConnection(stageId);
        this.applyConnection(data.connection);
        if (!data.validation.ok) {
          this.error.value = describeValidationFailure(data.validation);
        }
      } catch (err) {
        this.error.value = err instanceof Error ? err.message : String(err);
        await this.load();
      } finally {
        this.status.value = "idle";
      }
    },

    async remove(): Promise<void> {
      this.status.value = "deleting";
      this.error.value = null;
      try {
        await apiFetch<{ ok: boolean }>("/api/v1/npm-connection", { method: "DELETE" });
        this.connection.value = null;
        this.token.value = "";
      } catch (err) {
        this.error.value = err instanceof Error ? err.message : String(err);
      } finally {
        this.status.value = "idle";
      }
    },
  };
});

export function describeValidationFailure(validation: NpmCredentialValidation): string {
  if (validation.status === "invalid") {
    if (validation.reasons.includes("registry_auth_failed")) {
      return "npm rejected the token — check it has registry access and try again.";
    }
    if (validation.reasons.includes("staged_list_denied")) {
      return "npm rejected staged-publish list access — the token needs staged-publish list/view/download capability.";
    }
    return "npm validation failed.";
  }
  if (validation.status === "capability_limited") {
    if (validation.reasons.includes("no_stages_to_probe")) {
      return "Auth and staged-list access look good, but no open staged publishes were available to confirm view + download. Create a stage or paste a stage ID below to finish validation.";
    }
    const missing: string[] = [];
    if (validation.reasons.includes("staged_view_denied")) missing.push("view");
    if (validation.reasons.includes("staged_tarball_denied")) missing.push("download");
    return missing.length
      ? `Token is missing staged-publish ${missing.join(" + ")} capability — grant it before scanning.`
      : "Token capability check did not complete.";
  }
  return "";
}

function saveNpmConnection(input: {
  token: string;
  label: string;
  registryUrl: string;
}): Promise<{ connection: PublicNpmConnection | null }> {
  return apiFetch<{ connection: PublicNpmConnection | null }>("/api/v1/npm-connection", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

function validateNpmConnection(stageId?: string): Promise<{
  validation: NpmCredentialValidation;
  connection: PublicNpmConnection | null;
}> {
  return apiFetch<{
    validation: NpmCredentialValidation;
    connection: PublicNpmConnection | null;
  }>("/api/v1/npm-connection/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stageId }),
  });
}
