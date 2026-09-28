import { computed, createModel, effect, signal } from "@preact/signals";
import { activeOrganizationId } from "./active-organization";
import { ApiError, apiFetch, apiJson, errorMessage } from "./api";
import type { Organization } from "./organization";
import { encodePackageName } from "../lib/package-diff-path";

export interface PackageClaimManagement {
  claim: {
    kind: "personal" | "organization";
    managementConfirmed: boolean;
    canManage: boolean;
  } | null;
  destinations: Array<{ id: string; name: string }>;
}

/** A personal claim whose owner has not yet chosen to keep or move it. */
export function managementChoicePending(management: PackageClaimManagement | null): boolean {
  const claim = management?.claim;
  return claim?.kind === "personal" && claim.canManage && !claim.managementConfirmed;
}

/** A personal claim its owner can still move to a shared organization. */
function movable(management: PackageClaimManagement | null): boolean {
  const claim = management?.claim;
  return claim?.kind === "personal" && claim.canManage === true;
}

export const PackageClaimModel = createModel((packageName: string, registryUrl?: string) => {
  const management = signal<PackageClaimManagement | null>(null);
  const organization = signal<Organization | null>(null);
  const selectedOrganizationId = signal("");
  // Set only once a transfer committed; the destination then manages the package.
  const movedTo = signal<{ id: string; name: string } | null>(null);
  const kept = signal(false);
  const loading = signal(true);
  const busy = signal(false);
  const error = signal<string | null>(null);
  const pending = computed(() => managementChoicePending(management.value));
  let generation = 0;
  const endpoint = `/api/v1/npm-package-claims/${encodePackageName(packageName)}`;

  async function read(current: number) {
    const [result, orgs] = await Promise.all([
      apiFetch<PackageClaimManagement>(
        registryUrl ? `${endpoint}?${new URLSearchParams({ registryUrl })}` : endpoint,
      ),
      apiFetch<{ organizations: Organization[] }>("/api/v1/organizations"),
    ]);
    if (current !== generation) return;
    management.value = result;
    const source =
      orgs.organizations.find((org) => org.id === activeOrganizationId.peek()) ??
      orgs.organizations[0] ??
      null;
    organization.value = source;
    // A shared destination is preferred; with none, keeping is the only choice.
    if (!selectedOrganizationId.peek())
      selectedOrganizationId.value = source?.isPersonal
        ? (result.destinations[0]?.id ?? source.id)
        : (source?.id ?? "");
  }

  async function load() {
    const current = generation;
    loading.value = true;
    error.value = null;
    try {
      await read(current);
    } catch (err) {
      if (current !== generation) return;
      // The claims route refuses names it could never have claimed (a gate
      // review's manifest name, say), so there is nothing to manage.
      if (err instanceof ApiError && err.status === 400)
        management.value = { claim: null, destinations: [] };
      else error.value = errorMessage(err);
    } finally {
      if (current === generation) loading.value = false;
    }
  }
  effect(() => {
    void activeOrganizationId.value;
    generation++;
    management.value = null;
    organization.value = null;
    movedTo.value = null;
    kept.value = false;
    selectedOrganizationId.value = "";
    busy.value = false;
    void load();
    return () => {
      generation++;
    };
  });

  return {
    management,
    organization,
    selectedOrganizationId,
    movedTo,
    kept,
    pending,
    loading,
    busy,
    error,
    load,
    /** Keeps the claim in the personal workspace or moves it to the selected organization. */
    async choose(): Promise<"kept" | "moved" | null> {
      const source = organization.peek();
      const data = management.peek();
      const targetId = selectedOrganizationId.peek();
      if (!source || !data?.claim || !movable(data) || !targetId || busy.peek()) return null;
      const current = generation;
      const target = data.destinations.find((item) => item.id === targetId);
      if (targetId !== source.id && !target) return null;
      if (targetId === source.id && data.claim.managementConfirmed) return "kept";
      busy.value = true;
      error.value = null;
      let committed = false;
      try {
        await apiJson(endpoint, { targetOrganizationId: targetId, registryUrl });
        if (current !== generation) return null;
        committed = true;
        if (target) {
          movedTo.value = target;
          management.value = { ...data, claim: null };
        } else {
          kept.value = true;
          management.value = { ...data, claim: { ...data.claim, managementConfirmed: true } };
        }
        await read(current);
        return current === generation ? (target ? "moved" : "kept") : null;
      } catch (err) {
        if (current !== generation) return null;
        if (!committed) {
          error.value = choiceErrorMessage(err);
          return null;
        }
        error.value = `Your package choice was saved, but a follow-up request failed: ${errorMessage(err)}. Reload to check its current status.`;
        return target ? "moved" : "kept";
      } finally {
        if (current === generation) busy.value = false;
      }
    },
  };
});

function choiceErrorMessage(err: unknown): string {
  // The server answers a lost role or a moved claim with a bare "forbidden".
  if (err instanceof ApiError && err.status === 403)
    return "You no longer have permission to manage this package here.";
  return errorMessage(err);
}
