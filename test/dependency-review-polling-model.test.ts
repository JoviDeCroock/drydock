import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  POLL_BASE_DELAY_MS,
  POLL_MAX_DELAY_MS,
  POLL_STALL_AFTER_MS,
} from "../src/models/background-poll";
import {
  DependencyReviewDetailModel,
  DependencyReviewsModel,
  type DependencyReview,
} from "../src/models/dependency-review";
import { DEFAULT_DEPENDENCY_REVIEW_POLICY } from "../server/lib/dependency-review/types";
import { jsonResponse } from "./helpers/fetch-stub";

function review(overrides: Partial<DependencyReview> = {}): DependencyReview {
  return {
    id: "dr_1",
    organizationId: "org_1",
    installationRowId: "inst_1",
    repositoryId: 1,
    repositoryFullName: "acme/web",
    pullNumber: 12,
    headSha: "abcdef0123456",
    authorLogin: "dependabot[bot]",
    checkRunId: null,
    status: "running",
    conclusion: null,
    bumpCount: 1,
    heldCount: 0,
    approvedByLogin: null,
    approvedAt: null,
    createdAt: "2026-11-07T00:00:00.000Z",
    updatedAt: "2026-11-07T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

function overview(reviews: DependencyReview[], enabled = true) {
  return {
    settings: { enabled, policy: DEFAULT_DEPENDENCY_REVIEW_POLICY, extraBotLogins: [] },
    githubAppInstalled: true,
    reviews,
    viewer: { canManage: true },
  };
}

function failedResponse(): Response {
  return jsonResponse({ error: "boom" }, 500);
}

let disposables: Array<{ [Symbol.dispose](): void }> = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const model of disposables) model[Symbol.dispose]();
  disposables = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("DependencyReviewDetailModel polling", () => {
  function detailModel() {
    const model = new DependencyReviewDetailModel("dr_1");
    disposables.push(model);
    return model;
  }

  test("follows a running review to its result, then stops", async () => {
    let current = review({ status: "queued" });
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ review: current, bumps: [] })));
    vi.stubGlobal("fetch", fetchMock);

    const model = detailModel();
    await model.load();
    expect(model.inFlight.value).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    current = review({ status: "running" });
    await vi.advanceTimersByTimeAsync(POLL_BASE_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(model.review.value?.status).toBe("running");

    current = review({ status: "completed", conclusion: "clear" });
    await vi.advanceTimersByTimeAsync(POLL_BASE_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(model.review.value?.conclusion).toBe("clear");
    expect(model.inFlight.value).toBe(false);

    await vi.advanceTimersByTimeAsync(10 * POLL_MAX_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("does not poll a settled, failed, or superseded review", async () => {
    for (const settled of [
      review({ status: "completed", conclusion: "held" }),
      review({ status: "failed" }),
      review({ status: "superseded" }),
    ]) {
      const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ review: settled, bumps: [] })));
      vi.stubGlobal("fetch", fetchMock);
      const model = detailModel();
      await model.load();
      await vi.advanceTimersByTimeAsync(10 * POLL_MAX_DELAY_MS);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  test("a failed poll keeps the review on screen and backs off", async () => {
    let fail = false;
    const fetchMock = vi.fn(() =>
      Promise.resolve(fail ? failedResponse() : jsonResponse({ review: review(), bumps: [] })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const model = detailModel();
    await model.load();
    fail = true;

    await vi.advanceTimersByTimeAsync(POLL_BASE_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(model.error.value).not.toBeNull();
    expect(model.review.value?.id).toBe("dr_1");

    await vi.advanceTimersByTimeAsync(2 * POLL_BASE_DELAY_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fail = false;
    await vi.advanceTimersByTimeAsync(POLL_MAX_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(model.error.value).toBeNull();
  });

  test("stalls after the window and resumes by hand", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ review: review(), bumps: [] })));
    vi.stubGlobal("fetch", fetchMock);

    const model = detailModel();
    await model.load();
    await vi.advanceTimersByTimeAsync(POLL_STALL_AFTER_MS);
    expect(model.pollingStalled.value).toBe(true);
    const callsAtStall = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * POLL_MAX_DELAY_MS);
    expect(fetchMock.mock.calls.length).toBe(callsAtStall);

    model.resumePolling();
    expect(model.pollingStalled.value).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(callsAtStall + 1);
    await vi.advanceTimersByTimeAsync(POLL_BASE_DELAY_MS);
    expect(fetchMock.mock.calls.length).toBe(callsAtStall + 2);
  });
});

describe("DependencyReviewsModel polling", () => {
  test("the review list refreshes its rows while one is in flight", async () => {
    let rows = [review({ status: "running" }), review({ id: "dr_0", status: "completed" })];
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(overview(rows))));
    vi.stubGlobal("fetch", fetchMock);

    const model = new DependencyReviewsModel({ followReviews: true });
    disposables.push(model);
    await model.load();
    expect(model.anyInFlight.value).toBe(true);

    rows = [review({ status: "completed", conclusion: "held", heldCount: 1 }), rows[1]!];
    await vi.advanceTimersByTimeAsync(POLL_BASE_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(model.reviews.value[0]?.conclusion).toBe("held");
    expect(model.anyInFlight.value).toBe(false);

    await vi.advanceTimersByTimeAsync(10 * POLL_MAX_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("a poll leaves an unsaved settings draft alone", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(overview([review()]))));
    vi.stubGlobal("fetch", fetchMock);

    const model = new DependencyReviewsModel({ followReviews: true });
    disposables.push(model);
    await model.load();
    model.setEnabled(false);
    model.setBotLogins("my-renovate[bot]");

    await vi.advanceTimersByTimeAsync(POLL_BASE_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(model.draftEnabled.value).toBe(false);
    expect(model.draftBotLogins.value).toBe("my-renovate[bot]");
    expect(model.dirty.value).toBe(true);
  });

  test("the settings page's model does not poll", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(overview([review()]))));
    vi.stubGlobal("fetch", fetchMock);

    const model = new DependencyReviewsModel();
    disposables.push(model);
    await model.load();
    await vi.advanceTimersByTimeAsync(10 * POLL_MAX_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
