/**
 * Whether the active organization's reviews answer one package's public
 * README badge, and the owner/admin switch that turns that off.
 */
import { createModel, signal } from "@preact/signals";
import { encodePackageName } from "../lib/package-diff-path";
import { activeOrganizationId } from "./active-organization";
import { apiFetch, apiJson, errorMessage } from "./api";

export interface PackageBadgeState {
  enabled: boolean;
  disabledAt: string | null;
  /** An approved public release of this organization's answers with no opt-in. */
  answersByDefault: boolean;
  /** This organization has feed-listed a review under the package's name. */
  listed: boolean;
  /** Whether the viewer may change it (owner or admin). */
  canManage: boolean;
}

interface PackageBadgeResponse {
  package: { name: string; ecosystem: string };
  badge: PackageBadgeState;
}

function packageBadgeApiPath(packageName: string, ecosystem: string): string {
  const query = ecosystem !== "npm" ? `?ecosystem=${encodeURIComponent(ecosystem)}` : "";
  return `/api/v1/packages/${encodePackageName(packageName)}/badge${query}`;
}

export const PackageBadgeModel = createModel((packageName: string, ecosystem: string) => {
  const state = signal<PackageBadgeState | null>(null);
  const busy = signal(false);
  const error = signal<string | null>(null);
  // An organization switch mid-flight must not land the previous
  // organization's answer in the new one's view.
  let requestId = 0;

  async function run(request: () => Promise<PackageBadgeResponse>): Promise<void> {
    const id = ++requestId;
    const organizationId = activeOrganizationId.peek();
    busy.value = true;
    try {
      const data = await request();
      if (id !== requestId || organizationId !== activeOrganizationId.peek()) return;
      state.value = data.badge;
      error.value = null;
    } catch (err) {
      if (id === requestId) error.value = errorMessage(err);
    } finally {
      if (id === requestId) busy.value = false;
    }
  }

  function load(): Promise<void> {
    return run(() => apiFetch<PackageBadgeResponse>(packageBadgeApiPath(packageName, ecosystem)));
  }

  function setEnabled(enabled: boolean): Promise<void> {
    if (busy.peek()) return Promise.resolve();
    return run(() =>
      apiJson<PackageBadgeResponse>(
        packageBadgeApiPath(packageName, ecosystem),
        { enabled },
        { method: "PUT" },
      ),
    );
  }

  return { state, busy, error, load, setEnabled };
});
