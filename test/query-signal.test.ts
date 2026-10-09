import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Hooks run inline on a single render, and `route` is unscoped, so the test
// sees useQuerySignal's own pathname guard rather than ScopedRoute's.
const harness = vi.hoisted(() => ({
  route: null as unknown as (url: string, replace?: boolean) => void,
  disposers: [] as Array<() => void>,
}));

vi.mock("preact/hooks", () => ({
  useEffect: (callback: () => void) => callback(),
  useRef: (initial: unknown) => ({ current: initial }),
}));

vi.mock("preact-iso", () => ({
  useLocation: () => ({ query: {}, route: harness.route }),
}));

vi.mock("@preact/signals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@preact/signals")>();
  return {
    ...actual,
    useSignalEffect: (callback: () => void | (() => void)) => {
      harness.disposers.push(actual.effect(callback));
    },
  };
});

const { signal } = await import("@preact/signals");
const { useQuerySignal } = await import("../src/lib/query-state");

const location = { pathname: "/diff", search: "", hash: "" };

function renderFileQuery() {
  const file = signal("");
  useQuerySignal(file, {
    name: "file",
    parse: (raw) => raw ?? "",
    serialize: (value) => value || null,
    debounceMs: 200,
  });
  return file;
}

describe("useQuerySignal debounced write", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(location, { pathname: "/diff", search: "", hash: "" });
    harness.route = vi.fn();
    vi.stubGlobal("window", {
      location,
      setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    });
  });

  afterEach(() => {
    for (const dispose of harness.disposers.splice(0)) dispose();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("lands when the browser is still on the page's path", () => {
    const file = renderFileQuery();
    file.value = "lib/index.js";
    vi.advanceTimersByTime(200);

    expect(harness.route).toHaveBeenCalledExactlyOnceWith("/diff?file=lib%2Findex.js", true);
  });

  test("is dropped once the browser has moved to another path", () => {
    const file = renderFileQuery();
    file.value = "lib/index.js";
    location.pathname = "/login";
    vi.advanceTimersByTime(200);

    expect(harness.route).not.toHaveBeenCalled();
  });
});
