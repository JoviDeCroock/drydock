/**
 * Dependency review: the GitHub App's check on Dependabot and Renovate pull
 * requests. One model owns the organization's settings and its recent
 * reviews (one endpoint returns both); a second reads one review's bumps.
 */
import { computed, createModel, signal } from "@preact/signals";
import type { DependencyReviewRecord } from "../../server/db/dependency-reviews";
import {
  DEFAULT_DEPENDENCY_REVIEW_POLICY,
  type DependencyReviewPolicy,
  type ReviewedBump,
} from "../../server/lib/dependency-review/types";
import { activeOrganizationId } from "./active-organization";
import { ApiError, apiFetch, apiJson, errorMessage } from "./api";

export type { DependencyReviewPolicy, ReviewedBump };

// Dates arrive as JSON strings.
type Wire<T> = {
  [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K];
};

export type DependencyReview = Wire<DependencyReviewRecord>;

export interface DependencyReviewSettings {
  enabled: boolean;
  policy: DependencyReviewPolicy;
  extraBotLogins: string[];
}

interface OverviewResponse {
  settings: DependencyReviewSettings;
  githubAppInstalled: boolean;
  reviews: DependencyReview[];
  viewer: { canManage: boolean };
}

const BASE = "/api/v1/dependency-reviews";

/** Bot logins typed as one comma- or whitespace-separated line. */
export function parseBotLoginsInput(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((login) => login.trim())
    .filter(Boolean);
}

function sameSettings(a: DependencyReviewSettings, b: DependencyReviewSettings): boolean {
  return (
    a.enabled === b.enabled &&
    JSON.stringify(a.policy) === JSON.stringify(b.policy) &&
    a.extraBotLogins.join(",") === b.extraBotLogins.join(",")
  );
}

export const DependencyReviewsModel = createModel(() => {
  const loaded = signal(false);
  const error = signal<string | null>(null);
  const saved = signal<DependencyReviewSettings | null>(null);
  const githubAppInstalled = signal(false);
  const reviews = signal<DependencyReview[]>([]);
  const canManage = signal(false);

  const draftEnabled = signal(false);
  const draftPolicy = signal<DependencyReviewPolicy>(DEFAULT_DEPENDENCY_REVIEW_POLICY);
  const draftBotLogins = signal("");
  const saving = signal(false);
  const saveError = signal<string | null>(null);
  const justSaved = signal(false);

  // An organization switch mid-flight must not land the previous
  // organization's settings or reviews in the new one's view.
  let requestId = 0;

  const draft = computed<DependencyReviewSettings>(() => ({
    enabled: draftEnabled.value,
    policy: draftPolicy.value,
    extraBotLogins: parseBotLoginsInput(draftBotLogins.value),
  }));
  const dirty = computed(() => {
    const current = saved.value;
    const next = draft.value;
    return current !== null && !sameSettings(current, next);
  });

  function resetDraft(settings: DependencyReviewSettings) {
    draftEnabled.value = settings.enabled;
    draftPolicy.value = settings.policy;
    draftBotLogins.value = settings.extraBotLogins.join(", ");
  }

  return {
    loaded,
    error,
    saved,
    githubAppInstalled,
    reviews,
    canManage,
    draftEnabled,
    draftPolicy,
    draftBotLogins,
    saving,
    saveError,
    justSaved,
    dirty,

    async load(): Promise<void> {
      const id = ++requestId;
      const organizationId = activeOrganizationId.peek();
      try {
        const data = await apiFetch<OverviewResponse>(BASE);
        if (id !== requestId || organizationId !== activeOrganizationId.peek()) return;
        saved.value = data.settings;
        githubAppInstalled.value = data.githubAppInstalled;
        reviews.value = data.reviews;
        canManage.value = data.viewer.canManage;
        resetDraft(data.settings);
        error.value = null;
        saveError.value = null;
        justSaved.value = false;
      } catch (err) {
        if (id !== requestId) return;
        error.value = errorMessage(err);
        saved.value = null;
        reviews.value = [];
        canManage.value = false;
      } finally {
        if (id === requestId) loaded.value = true;
      }
    },

    setPolicy<K extends keyof DependencyReviewPolicy>(key: K, value: DependencyReviewPolicy[K]) {
      draftPolicy.value = { ...draftPolicy.peek(), [key]: value };
      justSaved.value = false;
    },

    setEnabled(value: boolean) {
      draftEnabled.value = value;
      justSaved.value = false;
    },

    setBotLogins(value: string) {
      draftBotLogins.value = value;
      justSaved.value = false;
    },

    discard() {
      const current = saved.peek();
      if (current) resetDraft(current);
      saveError.value = null;
    },

    async save(): Promise<boolean> {
      if (saving.peek()) return false;
      const id = requestId;
      saving.value = true;
      saveError.value = null;
      try {
        const data = await apiJson<{ settings: DependencyReviewSettings }>(
          `${BASE}/settings`,
          draft.peek(),
          { method: "PUT" },
        );
        if (id !== requestId) return false;
        saved.value = data.settings;
        resetDraft(data.settings);
        justSaved.value = true;
        return true;
      } catch (err) {
        if (id === requestId) saveError.value = errorMessage(err);
        return false;
      } finally {
        if (id === requestId) saving.value = false;
      }
    },
  };
});

export const DependencyReviewDetailModel = createModel((reviewId: string) => {
  const loaded = signal(false);
  const error = signal<string | null>(null);
  const notFound = signal(false);
  const review = signal<DependencyReview | null>(null);
  const bumps = signal<ReviewedBump[]>([]);
  let requestId = 0;

  return {
    loaded,
    error,
    notFound,
    review,
    bumps,

    async load(): Promise<void> {
      const id = ++requestId;
      try {
        const data = await apiFetch<{ review: DependencyReview; bumps: ReviewedBump[] }>(
          `${BASE}/${encodeURIComponent(reviewId)}`,
        );
        if (id !== requestId) return;
        review.value = data.review;
        bumps.value = data.bumps;
        error.value = null;
        notFound.value = false;
      } catch (err) {
        if (id !== requestId) return;
        if (err instanceof ApiError && err.status === 404) notFound.value = true;
        else error.value = errorMessage(err);
      } finally {
        if (id === requestId) loaded.value = true;
      }
    },
  };
});
