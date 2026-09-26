import { computed, createModel, effect, signal } from "@preact/signals";
import { activeOrganizationId } from "./active-organization";
import { apiFetch, apiJson, errorMessage } from "./api";

export interface PublicNpmConnection {
  id: string;
  organizationId: string;
  registryUrl: string;
  label: string;
  tokenFingerprint: string;
  tokenLast4: string | null;
  validationStatus: string;
  capabilitiesJson: unknown;
  personalOrganizationConfirmedAt?: string | number | Date | null;
  validatedAt: string | number | Date | null;
  lastUsedAt: string | number | Date | null;
  createdByUserId: string | null;
  createdAt: string | number | Date;
  updatedAt: string | number | Date;
}

/**
 * The npm scope this organization's token authenticates as (`@username`), read
 * off the stored `whoami` capability. Only a validated connection answers: an
 * unvalidated one's capabilities are a stale record of a token that may no
 * longer exist, and prefilling a field from it would be a confident guess.
 */
export function npmConnectionScope(connection: PublicNpmConnection | null): string | null {
  if (!connection || connection.validationStatus !== "valid") return null;
  const capabilities = connection.capabilitiesJson;
  if (!capabilities || typeof capabilities !== "object") return null;
  const whoami = (capabilities as { whoami?: unknown }).whoami;
  return typeof whoami === "string" && whoami ? `@${whoami}` : null;
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

  const busy = computed(() => status.value !== "idle");
  const isConnected = computed(() => connection.value !== null);
  const validated = computed(() => connection.value?.validationStatus === "valid");

  // Responses are applied only if no organization switch happened since the
  // request started. Comparing organization IDs alone would accept a stale
  // response after an A -> B -> A switch.
  let generation = 0;
  let latestLoad = 0;
  effect(() => {
    void activeOrganizationId.value;
    generation++;
    status.value = "idle";
    error.value = null;
  });

  function applyConnection(next: PublicNpmConnection | null) {
    connection.value = next;
    if (next) {
      label.value = next.label;
      registry.value = next.registryUrl;
    } else {
      label.value = DEFAULT_LABEL;
      registry.value = DEFAULT_REGISTRY;
    }
    token.value = "";
    validationStageId.value = "";
  }

  async function load(): Promise<void> {
    const current = generation;
    const request = ++latestLoad;
    const isCurrent = () => current === generation && request === latestLoad;
    try {
      const data = await apiFetch<{ connection: PublicNpmConnection | null }>(
        "/api/v1/npm-connection",
      );
      if (isCurrent()) applyConnection(data.connection);
    } catch {
      // Keep the dashboard usable; scan creation enforces the requirement.
    } finally {
      if (isCurrent()) loaded.value = true;
    }
  }

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
    load,

    async save(confirmPersonalOrganization = false): Promise<void> {
      const current = generation;
      const trimmedToken = token.peek().trim();
      if (!trimmedToken) return;
      status.value = "saving";
      error.value = null;
      try {
        const data = await saveNpmConnection({
          confirmPersonalOrganization,
          token: trimmedToken,
          label: label.peek().trim() || DEFAULT_LABEL,
          registryUrl: registry.peek().trim() || DEFAULT_REGISTRY,
        });
        if (current !== generation) return;
        applyConnection(data.connection);
        if (data.connection) {
          status.value = "validating";
          const validation = await validateNpmConnection(undefined, confirmPersonalOrganization);
          if (current !== generation) return;
          applyConnection(validation.connection);
          if (!validation.validation.ok) {
            error.value = "Saved token, but npm validation reported invalid access.";
          }
        }
      } catch (err) {
        if (current !== generation) return;
        error.value = errorMessage(err);
        await load();
      } finally {
        if (current === generation) status.value = "idle";
      }
    },

    async validate(confirmPersonalOrganization = false): Promise<void> {
      const current = generation;
      status.value = "validating";
      error.value = null;
      try {
        const stageId = validationStageId.peek().trim() || undefined;
        const data = await validateNpmConnection(stageId, confirmPersonalOrganization);
        if (current !== generation) return;
        applyConnection(data.connection);
        if (!data.validation.ok) {
          error.value = "Npm validation reported invalid access.";
        }
      } catch (err) {
        if (current !== generation) return;
        error.value = errorMessage(err);
        await load();
      } finally {
        if (current === generation) status.value = "idle";
      }
    },

    /**
     * Records the personal-workspace choice for an existing connection. It does
     * not contact npm, so an unreachable registry cannot block the choice, and
     * it leaves any token being typed in the form untouched.
     */
    async confirmPersonalOrganization(): Promise<boolean> {
      const current = generation;
      status.value = "saving";
      error.value = null;
      try {
        const data = await apiJson<{ connection: PublicNpmConnection | null }>(
          "/api/v1/npm-connection/personal-confirmation",
          {},
        );
        if (current !== generation) return false;
        connection.value = data.connection;
        return true;
      } catch (err) {
        if (current === generation) error.value = errorMessage(err);
        return false;
      } finally {
        if (current === generation) status.value = "idle";
      }
    },

    async remove(): Promise<void> {
      const current = generation;
      status.value = "deleting";
      error.value = null;
      try {
        await apiFetch<{ ok: boolean }>("/api/v1/npm-connection", { method: "DELETE" });
        if (current !== generation) return;
        connection.value = null;
        token.value = "";
      } catch (err) {
        if (current === generation) error.value = errorMessage(err);
      } finally {
        if (current === generation) status.value = "idle";
      }
    },
  };
});

function saveNpmConnection(input: {
  confirmPersonalOrganization?: boolean;
  token: string;
  label: string;
  registryUrl: string;
}): Promise<{ connection: PublicNpmConnection | null }> {
  return apiJson<{ connection: PublicNpmConnection | null }>("/api/v1/npm-connection", input);
}

function validateNpmConnection(
  stageId?: string,
  confirmPersonalOrganization = false,
): Promise<{
  validation: NpmCredentialValidation;
  connection: PublicNpmConnection | null;
}> {
  return apiJson<{
    validation: NpmCredentialValidation;
    connection: PublicNpmConnection | null;
  }>("/api/v1/npm-connection/validate", { stageId, confirmPersonalOrganization });
}
