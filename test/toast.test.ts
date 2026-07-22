import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  clearToastsForTest,
  dismissToast,
  holdToast,
  pushToast,
  releaseToast,
  toastItemsForTest,
} from "../src/components/Toast";

describe("toast store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearToastsForTest();
    vi.useRealTimers();
  });

  test("ok/info toasts auto-dismiss after the TTL", () => {
    pushToast("saved", "ok");
    expect(toastItemsForTest()).toHaveLength(1);
    vi.advanceTimersByTime(4000);
    expect(toastItemsForTest()).toHaveLength(0);
  });

  test("critical toasts never auto-dismiss", () => {
    pushToast("Slack connection failed", "critical");
    vi.advanceTimersByTime(60_000);
    expect(toastItemsForTest()).toHaveLength(1);
    dismissToast(toastItemsForTest()[0].id);
    expect(toastItemsForTest()).toHaveLength(0);
  });

  test("hold pauses the clock and release restarts a full TTL", () => {
    pushToast("copied", "info");
    const id = toastItemsForTest()[0].id;
    vi.advanceTimersByTime(3000);
    holdToast(id);
    // Held: far past the original deadline, still visible.
    vi.advanceTimersByTime(60_000);
    expect(toastItemsForTest()).toHaveLength(1);
    releaseToast(id);
    vi.advanceTimersByTime(3999);
    expect(toastItemsForTest()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(toastItemsForTest()).toHaveLength(0);
  });

  test("overlapping hover and focus holds are refcounted", () => {
    pushToast("copied", "info");
    const id = toastItemsForTest()[0].id;
    // Hover, then keyboard focus lands on the dismiss button.
    holdToast(id);
    holdToast(id);
    // Mouse leaves while focus is still inside: the clock must stay stopped —
    // dismissing here would strand keyboard focus on <body>.
    releaseToast(id);
    vi.advanceTimersByTime(60_000);
    expect(toastItemsForTest()).toHaveLength(1);
    // Focus leaves too: last release restarts a full TTL.
    releaseToast(id);
    vi.advanceTimersByTime(4000);
    expect(toastItemsForTest()).toHaveLength(0);
  });

  test("release is a no-op for critical and already-scheduled toasts", () => {
    pushToast("boom", "critical");
    const id = toastItemsForTest()[0].id;
    releaseToast(id);
    vi.advanceTimersByTime(60_000);
    expect(toastItemsForTest()).toHaveLength(1);
  });

  test("manual dismissal clears the pending timer", () => {
    pushToast("saved", "ok");
    const id = toastItemsForTest()[0].id;
    dismissToast(id);
    pushToast("next", "ok");
    // The stale timer must not remove the newer toast.
    vi.advanceTimersByTime(3999);
    expect(toastItemsForTest()).toHaveLength(1);
  });
});
