/**
 * Dependency review: the GitHub App's check on pull requests from branches
 * in the installed repository. One model owns the organization's settings
 * and recent reviews (one endpoint returns both); a second reads one review's bumps.
 * Both follow a queued or running review to its result while the page is
 * open, on the same cadence as a running scan.
 */
import { computed, createModel, effect, signal } from "@preact/signals";
import type {
  DependencyReviewCoverage,
  DependencyReviewRecord,
} from "../../server/db/dependency-reviews";
import {
  DEFAULT_DEPENDENCY_REVIEW_POLICY,
  type DependencyReviewPolicy,
  type ReviewedBump,
} from "../../server/lib/dependency-review/types";
import { activeOrganizationId } from "./active-organization";
import { ApiError, apiFetch, apiJson, errorMessage } from "./api";
import { startBackgroundPoll } from "./background-poll";

export type { DependencyReviewCoverage, DependencyReviewPolicy, ReviewedBump };

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

/** Whether the review is still waiting for a result. */
function isReviewInFlight(review: Pick<DependencyReview, "status">): boolean {
  return review.status === "queued" || review.status === "running";
}

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

/**
 * `followReviews` polls while a listed review is in flight. Only the review
 * list opts in: the settings page shares this model and must not spend reads
 * on rows it never shows.
 */
export const DependencyReviewsModel = createModel((options: { followReviews?: boolean } = {}) => {
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
  const pollingStalled = signal(false);

  // An organization switch mid-flight must not land the previous
  // organization's settings or reviews in the new one's view.
  let requestId = 0;

  const anyInFlight = computed(() => reviews.value.some(isReviewInFlight));

  // A poll refreshes the rows only. The settings it also returns would
  // overwrite a draft the reader is editing.
  async function pollReviews(): Promise<boolean> {
    const id = requestId;
    const organizationId = activeOrganizationId.peek();
    try {
      const data = await apiFetch<OverviewResponse>(BASE);
      if (id !== requestId || organizationId !== activeOrganizationId.peek()) return true;
      reviews.value = data.reviews;
      error.value = null;
      return true;
    } catch (err) {
      if (id === requestId) error.value = errorMessage(err);
      return false;
    }
  }

  if (options.followReviews) {
    effect(() => {
      const following = anyInFlight.value;
      const stalled = pollingStalled.value;
      if (!following || stalled) return;
      return startBackgroundPoll(pollReviews, () => {
        pollingStalled.value = true;
      });
    });
  }

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
    anyInFlight,
    pollingStalled,

    async load(): Promise<void> {
      const id = ++requestId;
      const organizationId = activeOrganizationId.peek();
      pollingStalled.value = false;
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

    /** Manual recovery from the stalled state: read now and restart the chain. */
    resumePolling(): void {
      pollingStalled.value = false;
      void pollReviews();
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
  const coverage = signal<DependencyReviewCoverage>({
    unreadLockfiles: [],
    listingComplete: true,
  });
  // Whether the check offers Approve, decided by the server's `listsEveryHold`.
  const approvable = signal(false);
  // A later commit of the same pull request has its own review.
  const newerReviewId = signal<string | null>(null);
  const pollingStalled = signal(false);
  let requestId = 0;

  const inFlight = computed(() => {
    const current = review.value;
    return current !== null && isReviewInFlight(current);
  });

  // A failed read keeps the review already on screen; the error shows above
  // it, as on a running scan.
  async function read(id: number): Promise<boolean> {
    try {
      const data = await apiFetch<{
        review: DependencyReview;
        bumps: ReviewedBump[];
        coverage: DependencyReviewCoverage;
        approvable?: boolean;
        newerReviewId?: string | null;
      }>(`${BASE}/${encodeURIComponent(reviewId)}`);
      if (id !== requestId) return true;
      review.value = data.review;
      bumps.value = data.bumps;
      coverage.value = data.coverage;
      approvable.value = data.approvable === true;
      newerReviewId.value = data.newerReviewId ?? null;
      error.value = null;
      notFound.value = false;
      return true;
    } catch (err) {
      if (id !== requestId) return false;
      if (err instanceof ApiError && err.status === 404) notFound.value = true;
      else error.value = errorMessage(err);
      return false;
    }
  }

  effect(() => {
    const following = inFlight.value;
    const stalled = pollingStalled.value;
    if (!following || stalled) return;
    return startBackgroundPoll(
      () => read(requestId),
      () => {
        pollingStalled.value = true;
      },
    );
  });

  return {
    loaded,
    error,
    notFound,
    review,
    bumps,
    coverage,
    approvable,
    newerReviewId,
    inFlight,
    pollingStalled,

    async load(): Promise<void> {
      const id = ++requestId;
      pollingStalled.value = false;
      await read(id);
      if (id === requestId) loaded.value = true;
    },

    /** Manual recovery from the stalled state: read now and restart the chain. */
    resumePolling(): void {
      pollingStalled.value = false;
      void read(requestId);
    },
  };
});
