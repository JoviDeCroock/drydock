import { computed, createModel, effect, signal } from "@preact/signals";
import {
  PROTECTION_HEALTH_FRESH_MS,
  type ProtectionHealthTarget,
} from "../../server/lib/github-app/protection-health-types";
import { activeOrganizationId } from "./active-organization";
import { apiFetch, errorMessage } from "./api";
import { dependencyReviewSettingsRevision } from "./dependency-review";

export type { ProtectionHealthTarget };

const BASE = "/api/v1/github-app/protection-health";

function evidenceIsStale(target: ProtectionHealthTarget, now: number): boolean {
  if (!target.checkedAt) return false;
  const checkedAt = Date.parse(target.checkedAt);
  return (
    Number.isFinite(checkedAt) && (target.stale || now - checkedAt >= PROTECTION_HEALTH_FRESH_MS)
  );
}

export function protectionHealthState(
  target: ProtectionHealthTarget,
  now: number,
): "verified" | "at_risk" | "unknown" | "stale" {
  if (target.status === "at_risk") return "at_risk";
  if (!target.checkedAt) return "unknown";
  const checkedAt = Date.parse(target.checkedAt);
  if (!Number.isFinite(checkedAt)) return "unknown";
  if (evidenceIsStale(target, now)) return "stale";
  return target.status === "protected" &&
    target.checks.length > 0 &&
    target.checks.every((check) => check.status === "passed")
    ? "verified"
    : "unknown";
}

export const ProtectionHealthModel = createModel(() => {
  const loaded = signal(false);
  const targets = signal<ProtectionHealthTarget[]>([]);
  const canRefresh = signal(false);
  const error = signal<string | null>(null);
  const refreshing = signal<string[]>([]);
  const refreshErrors = signal<Record<string, string>>({});
  const now = signal(Date.now());
  let requestId = 0;
  let overviewId = 0;
  const targetRevisions = new Map<string, number>();

  async function readOverview(): Promise<boolean> {
    const id = requestId;
    const readId = ++overviewId;
    const organizationId = activeOrganizationId.peek();
    const revisions = new Map(targetRevisions);
    try {
      const data = await apiFetch<{ targets: ProtectionHealthTarget[]; canRefresh: boolean }>(BASE);
      if (
        id !== requestId ||
        readId !== overviewId ||
        organizationId !== activeOrganizationId.peek()
      )
        return true;
      const current = new Map(targets.peek().map((target) => [target.releaseTargetId, target]));
      targets.value = data.targets.map((target) => {
        const targetId = target.releaseTargetId;
        const previous = current.get(targetId);
        const changed = revisions.get(targetId) !== targetRevisions.get(targetId);
        return previous && (changed || refreshing.peek().includes(targetId)) ? previous : target;
      });
      canRefresh.value = data.canRefresh;
      error.value = null;
      now.value = Date.now();
      return true;
    } catch (err) {
      if (
        id === requestId &&
        readId === overviewId &&
        organizationId === activeOrganizationId.peek()
      )
        error.value = errorMessage(err);
      return false;
    }
  }

  const states = computed(() =>
    Object.fromEntries(
      targets.value.map((target) => [
        target.releaseTargetId,
        protectionHealthState(target, now.value),
      ]),
    ),
  );
  const staleEvidence = computed(() =>
    Object.fromEntries(
      targets.value.map((target) => [target.releaseTargetId, evidenceIsStale(target, now.value)]),
    ),
  );

  effect(() => {
    if (targets.value.length === 0) return;
    const timer = setInterval(() => {
      now.value = Date.now();
    }, 60_000);
    return () => clearInterval(timer);
  });

  effect(() => {
    if (!loaded.value) return;
    let disposed = false;
    let delay = 60_000;
    const tick = async () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        const succeeded = await readOverview();
        delay = succeeded ? 60_000 : Math.min(delay * 2, 300_000);
      }
      if (!disposed) timer = setTimeout(() => void tick(), delay);
    };
    let timer = setTimeout(() => void tick(), delay);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  });

  let settingsRevision = dependencyReviewSettingsRevision.peek();
  effect(() => {
    const revision = dependencyReviewSettingsRevision.value;
    if (revision === settingsRevision) return;
    settingsRevision = revision;
    void readOverview();
  });

  return {
    loaded,
    targets,
    canRefresh,
    error,
    refreshing,
    refreshErrors,
    states,
    staleEvidence,

    async load(): Promise<void> {
      const id = ++requestId;
      const organizationId = activeOrganizationId.peek();
      loaded.value = false;
      targets.value = [];
      canRefresh.value = false;
      refreshing.value = [];
      refreshErrors.value = {};
      error.value = null;
      targetRevisions.clear();
      await readOverview();
      if (id === requestId && organizationId === activeOrganizationId.peek()) loaded.value = true;
    },

    async refresh(releaseTargetId: string): Promise<void> {
      if (!canRefresh.peek() || refreshing.peek().includes(releaseTargetId)) return;
      const id = requestId;
      const organizationId = activeOrganizationId.peek();
      targetRevisions.set(releaseTargetId, (targetRevisions.get(releaseTargetId) ?? 0) + 1);
      refreshing.value = [...refreshing.peek(), releaseTargetId];
      const nextErrors = { ...refreshErrors.peek() };
      delete nextErrors[releaseTargetId];
      refreshErrors.value = nextErrors;
      try {
        const data = await apiFetch<{ target: ProtectionHealthTarget }>(
          `${BASE}/${encodeURIComponent(releaseTargetId)}/refresh`,
          { method: "POST" },
        );
        if (id !== requestId || organizationId !== activeOrganizationId.peek()) return;
        targets.value = targets
          .peek()
          .map((target) => (target.releaseTargetId === releaseTargetId ? data.target : target));
        now.value = Date.now();
      } catch (err) {
        if (id === requestId && organizationId === activeOrganizationId.peek()) {
          refreshErrors.value = { ...refreshErrors.peek(), [releaseTargetId]: errorMessage(err) };
        }
      } finally {
        if (id === requestId && organizationId === activeOrganizationId.peek()) {
          refreshing.value = refreshing.peek().filter((target) => target !== releaseTargetId);
        }
      }
    },
  };
});
