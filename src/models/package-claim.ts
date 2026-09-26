import { createModel, effect, signal } from "@preact/signals";
import { activeOrganizationId } from "./active-organization";
import { apiFetch, apiJson, errorMessage } from "./api";
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

export const PackageClaimModel = createModel((packageName: string, registryUrl?: string) => {
  const management = signal<PackageClaimManagement | null>(null);
  const organization = signal<Organization | null>(null);
  const selectedOrganizationId = signal("");
  const movedTo = signal<{ id: string; name: string; transferred: boolean } | null>(null);
  const loading = signal(true);
  const busy = signal(false);
  const error = signal<string | null>(null);
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
    organization.value =
      orgs.organizations.find((org) => org.id === activeOrganizationId.peek()) ??
      orgs.organizations[0] ??
      null;
    if (!selectedOrganizationId.peek())
      selectedOrganizationId.value = organization.peek()?.isPersonal
        ? (result.destinations[0]?.id ?? "")
        : (organization.peek()?.id ?? "");
  }

  async function load() {
    const current = generation;
    loading.value = true;
    error.value = null;
    try {
      await read(current);
    } catch (err) {
      if (current === generation) error.value = errorMessage(err);
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
    loading,
    busy,
    error,
    load,
    async choose(watch = false): Promise<"watched" | "kept" | "moved" | null> {
      const source = organization.peek();
      const data = management.peek();
      const targetId = selectedOrganizationId.peek();
      if (!source || !data || !targetId || busy.peek()) return null;
      const current = generation;
      const target = data.destinations.find((item) => item.id === targetId);
      if (targetId !== source.id && !target) return null;
      busy.value = true;
      error.value = null;
      let committed: "watched" | "kept" | "moved" | null = null;
      try {
        if (data.claim?.kind === "personal" && data.claim.canManage) {
          await apiJson(endpoint, { targetOrganizationId: targetId, registryUrl });
          if (current !== generation) return null;
          committed = targetId === source.id ? "kept" : "moved";
          management.value = {
            ...data,
            claim: targetId === source.id ? { ...data.claim, managementConfirmed: true } : null,
          };
        }
        if (targetId !== source.id && target) {
          movedTo.value = { ...target, transferred: data.claim?.canManage === true };
          if (committed) await read(current);
          return current === generation ? "moved" : null;
        }
        if (watch) {
          await apiJson("/api/v1/publication-watches", {
            packageName,
            confirmPersonalOrganization: source.isPersonal,
          });
          if (current !== generation) return null;
          committed = "watched";
        }
        await read(current);
        return current === generation ? (watch ? "watched" : "kept") : null;
      } catch (err) {
        if (current !== generation) return null;
        error.value = committed
          ? `Your package choice was saved, but a follow-up request failed: ${errorMessage(err)}. Reload to check its current status.`
          : errorMessage(err);
        return committed;
      } finally {
        if (current === generation) busy.value = false;
      }
    },
  };
});
