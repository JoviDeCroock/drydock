/**
 * One package's public README badge as the active organization sees it: its
 * own "public badge: off" switch, whether another registry-verified publisher
 * switched the badge off, and what the public endpoint answers right now.
 */
import { createModel, effect, signal } from "@preact/signals";
import { encodePackageName } from "../lib/package-diff-path";
import { activeOrganizationId } from "./active-organization";
import { apiFetch, apiJson, errorMessage } from "./api";

export interface PackageBadgeState {
  /** This organization is a registry-verified publisher, so its switch counts. */
  eligible: boolean;
  switchedOffByYou: boolean;
  switchedOffAt: string | null;
  /** Another registry-verified publisher switched it off (never named). */
  switchedOffElsewhere: boolean;
  /** An approved public release of this organization's answers with no opt-in. */
  answersByDefault: boolean;
  /** This organization has feed-listed a review under the package's name. */
  listed: boolean;
  /** Whether the viewer may change it (owner or admin). */
  canManage: boolean;
}

/** The shields.io endpoint payload the public badge route returns. */
export interface BadgePreview {
  label: string;
  message: string;
  color: string;
}

interface PackageBadgeResponse {
  package: { name: string; ecosystem: string };
  badge: PackageBadgeState;
}

function badgeQuery(ecosystem: string): string {
  return ecosystem !== "npm" ? `?ecosystem=${encodeURIComponent(ecosystem)}` : "";
}

function publicBadgePath(packageName: string, ecosystem: string): string {
  return `/public/badge/${ecosystem}/${encodePackageName(packageName)}`;
}

export const PackageBadgeModel = createModel((packageName: string, ecosystem: string) => {
  const state = signal<PackageBadgeState | null>(null);
  const preview = signal<BadgePreview | null>(null);
  const busy = signal(false);
  const error = signal<string | null>(null);
  const apiPath = `/api/v1/packages/${encodePackageName(packageName)}/badge${badgeQuery(ecosystem)}`;
  // An organization switch mid-flight must not land the previous
  // organization's answer in the new one's view.
  let requestId = 0;

  // The anonymous endpoint, exactly as a README's badge proxy reads it. Best
  // effort: a failed preview leaves the rest of the section working.
  async function loadPreview(id: number): Promise<void> {
    try {
      const response = await fetch(publicBadgePath(packageName, ecosystem));
      const body = (await response.json()) as Partial<BadgePreview>;
      if (id !== requestId) return;
      preview.value =
        typeof body.label === "string" &&
        typeof body.message === "string" &&
        typeof body.color === "string"
          ? { label: body.label, message: body.message, color: body.color }
          : null;
    } catch {
      if (id === requestId) preview.value = null;
    }
  }

  async function run(request: () => Promise<PackageBadgeResponse>): Promise<void> {
    const id = ++requestId;
    const organizationId = activeOrganizationId.peek();
    busy.value = true;
    try {
      const data = await request();
      if (id !== requestId || organizationId !== activeOrganizationId.peek()) return;
      state.value = data.badge;
      error.value = null;
      await loadPreview(id);
    } catch (err) {
      if (id === requestId) error.value = errorMessage(err);
    } finally {
      if (id === requestId) busy.value = false;
    }
  }

  function load(): Promise<void> {
    return run(() => apiFetch<PackageBadgeResponse>(apiPath));
  }

  function setEnabled(enabled: boolean): Promise<void> {
    if (busy.peek()) return Promise.resolve();
    return run(() => apiJson<PackageBadgeResponse>(apiPath, { enabled }, { method: "PUT" }));
  }

  // Loads for the active organization, and again whenever it changes: a
  // response for the previous organization is dropped by `run`, so without
  // this a switch mid-flight would leave the section blank.
  effect(() => {
    void activeOrganizationId.value;
    state.value = null;
    preview.value = null;
    error.value = null;
    void load();
    // Invalidate responses arriving after a switch or after disposal.
    return () => {
      requestId++;
    };
  });

  return { state, preview, busy, error, load, setEnabled };
});
