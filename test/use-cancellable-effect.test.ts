import { beforeEach, describe, expect, test, vi } from "vitest";

type EffectCallback = () => void | (() => void);

// One mounted component: Preact runs a commit's layout effects before its
// passive ones, and the test drives that order by hand.
const hooks = vi.hoisted(() => ({
  layout: [] as EffectCallback[],
  passive: [] as EffectCallback[],
  ref: null as { current: unknown } | null,
}));

vi.mock("preact/hooks", () => ({
  useLayoutEffect: (callback: EffectCallback) => hooks.layout.push(callback),
  useEffect: (callback: EffectCallback) => hooks.passive.push(callback),
  useRef: (initial: unknown) => (hooks.ref ??= { current: initial }),
}));

const { useCancellableEffect } = await import("../src/lib/use-cancellable-effect");

function render(effect: (isCancelled: () => boolean) => void) {
  hooks.layout.length = 0;
  hooks.passive.length = 0;
  useCancellableEffect(effect, []);
  const layoutCleanup = hooks.layout[0]?.();
  return {
    layoutCleanup: layoutCleanup ?? (() => {}),
    runPassive: () => hooks.passive[0]?.(),
  };
}

describe("useCancellableEffect", () => {
  beforeEach(() => {
    hooks.ref = null;
  });

  test("starts the work in the passive phase, after the commit's layout effects", () => {
    const effect = vi.fn();
    const commit = render(effect);
    expect(effect).not.toHaveBeenCalled();
    commit.runPassive();
    expect(effect).toHaveBeenCalledOnce();
  });

  test("cancels from the layout cleanup, without waiting for the deferred passive cleanup", () => {
    let isCancelled = () => false;
    const commit = render((check) => (isCancelled = check));
    commit.runPassive();
    expect(isCancelled()).toBe(false);

    commit.layoutCleanup();
    expect(isCancelled()).toBe(true);
  });

  test("a deps change cancels the previous run and hands the next run a fresh check", () => {
    const checks: Array<() => boolean> = [];
    const first = render((check) => checks.push(check));
    first.runPassive();

    first.layoutCleanup();
    const second = render((check) => checks.push(check));
    second.runPassive();

    expect(checks.map((check) => check())).toEqual([true, false]);
  });
});
