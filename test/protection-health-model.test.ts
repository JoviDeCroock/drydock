import { afterEach, expect, test, vi } from "vitest";
import {
  ProtectionHealthModel,
  protectionHealthState,
  type ProtectionHealthTarget,
} from "../src/models/protection-health";
import { setActiveOrganizationId } from "../src/models/active-organization";
import { jsonResponse } from "./helpers/fetch-stub";
import { dependencyReviewSettingsRevision } from "../src/models/dependency-review";

const checkedAt = "2026-11-08T12:00:00.000Z";
const target: ProtectionHealthTarget = {
  releaseTargetId: "target-1",
  repositoryFullName: "acme/package",
  environment: "production",
  status: "protected",
  checkedAt,
  stale: false,
  defaultBranch: "main",
  checks: [{ id: "environment", label: "Environment", status: "passed", detail: "Verified." }],
  scope: "mapped_environment_and_default_branch",
};
const disposables: Array<{ [Symbol.dispose](): void }> = [];

afterEach(() => {
  for (const model of disposables.splice(0)) model[Symbol.dispose]();
  setActiveOrganizationId(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("stale or incomplete evidence never renders verified controls", () => {
  const now = Date.parse(checkedAt);
  expect(protectionHealthState(target, now)).toBe("verified");
  expect(protectionHealthState(target, now + 3_600_000)).toBe("stale");
  expect(protectionHealthState({ ...target, stale: true }, now)).toBe("stale");
  expect(protectionHealthState({ ...target, checkedAt: null }, now)).toBe("unknown");
  expect(protectionHealthState({ ...target, checks: [] }, now)).toBe("unknown");
  expect(
    protectionHealthState(
      { ...target, checks: [{ ...target.checks[0]!, status: "unknown" }] },
      now,
    ),
  ).toBe("unknown");
  expect(protectionHealthState({ ...target, status: "at_risk" }, now)).toBe("at_risk");
  expect(protectionHealthState({ ...target, status: "at_risk", checkedAt: null }, now)).toBe(
    "at_risk",
  );
  expect(protectionHealthState({ ...target, status: "at_risk", stale: true }, now)).toBe("at_risk");
});

test("fresh evidence expires while the page stays open", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(checkedAt));
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(jsonResponse({ targets: [target], canRefresh: true }))),
  );
  const model = new ProtectionHealthModel();
  disposables.push(model);
  await model.load();
  expect(model.states.value["target-1"]).toBe("verified");
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(model.states.value["target-1"]).toBe("stale");
});

test("refresh failures retain dated evidence, and concurrent refreshes are not duplicated", async () => {
  let finishRefresh!: (response: Response) => void;
  const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
    init?.method === "POST"
      ? new Promise<Response>((resolve) => {
          finishRefresh = resolve;
        })
      : Promise.resolve(jsonResponse({ targets: [target], canRefresh: true })),
  );
  vi.stubGlobal("fetch", fetchMock);
  const model = new ProtectionHealthModel();
  disposables.push(model);
  await model.load();
  const refreshing = model.refresh("target-1");
  await model.refresh("target-1");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  finishRefresh(jsonResponse({ error: "GitHub unavailable" }, 503));
  await refreshing;
  expect(model.targets.value).toEqual([target]);
  expect(model.refreshErrors.value["target-1"]).toContain("GitHub unavailable");
  expect(model.refreshing.value).toEqual([]);
});

test("an organization switch cannot receive an old refresh or load", async () => {
  setActiveOrganizationId("org-old");
  let finishRefresh!: (response: Response) => void;
  let count = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST")
        return new Promise<Response>((resolve) => {
          finishRefresh = resolve;
        });
      return Promise.resolve(
        jsonResponse({ targets: count++ === 0 ? [target] : [], canRefresh: count === 1 }),
      );
    }),
  );
  const model = new ProtectionHealthModel();
  disposables.push(model);
  await model.load();
  const refreshing = model.refresh("target-1");
  setActiveOrganizationId("org-new");
  await model.load();
  finishRefresh(jsonResponse({ target }));
  await refreshing;
  expect(model.targets.value).toEqual([]);
  expect(model.canRefresh.value).toBe(false);
  expect(model.refreshing.value).toEqual([]);
});

test("a late background snapshot cannot overwrite a newer manual refresh", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(checkedAt));
  let finishPoll!: (response: Response) => void;
  let reads = 0;
  const failed = {
    ...target,
    status: "at_risk" as const,
    checks: [{ ...target.checks[0]!, status: "failed" as const }],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve(jsonResponse({ target: failed }));
      if (++reads === 1)
        return Promise.resolve(jsonResponse({ targets: [target], canRefresh: true }));
      return new Promise<Response>((resolve) => {
        finishPoll = resolve;
      });
    }),
  );
  const model = new ProtectionHealthModel();
  disposables.push(model);
  await model.load();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(model.loaded.value).toBe(true);
  expect(model.targets.value).toEqual([target]);
  await model.refresh("target-1");
  expect(model.states.value["target-1"]).toBe("at_risk");
  finishPoll(jsonResponse({ targets: [target], canRefresh: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(model.targets.value).toEqual([failed]);
  expect(model.states.value["target-1"]).toBe("at_risk");
});

test("saved dependency settings reread health without clearing the current rows", async () => {
  let current = target;
  const fetchMock = vi.fn(() =>
    Promise.resolve(jsonResponse({ targets: [current], canRefresh: true })),
  );
  vi.stubGlobal("fetch", fetchMock);
  const model = new ProtectionHealthModel();
  disposables.push(model);
  await model.load();
  current = { ...target, status: "at_risk" };
  dependencyReviewSettingsRevision.value++;
  expect(model.loaded.value).toBe(true);
  expect(model.targets.value).toEqual([target]);
  await vi.waitFor(() => expect(model.targets.value).toEqual([current]));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("background refresh skips hidden pages and backs off after failed reads", async () => {
  vi.useFakeTimers();
  let visibilityState = "hidden";
  vi.stubGlobal("document", {
    get visibilityState() {
      return visibilityState;
    },
  });
  let reads = 0;
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      ++reads === 1
        ? jsonResponse({ targets: [target], canRefresh: true })
        : jsonResponse({ error: "temporarily unavailable" }, 503),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const model = new ProtectionHealthModel();
  disposables.push(model);
  await model.load();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  visibilityState = "visible";
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(model.error.value).toContain("temporarily unavailable");
  expect(model.targets.value).toEqual([target]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
