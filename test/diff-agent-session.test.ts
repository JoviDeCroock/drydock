import { afterEach, describe, expect, test, vi } from "vitest";
import { DiffAgentSession } from "../src/features/agent-review/diff-session";
import { packageDiffPath, type DiffSpec } from "../src/lib/package-diff-path";
import { ApiError } from "../src/models/api";
import {
  getPublicDiff,
  PackageDiffModel,
  type PublicDiffFileResponse,
  type PublicDiffResponse,
} from "../src/models/package-diff";
import { summarizePackageJsonDiff } from "../server/lib/review/serialize";

vi.mock("../src/models/package-diff", async (original) => ({
  ...(await original<typeof import("../src/models/package-diff")>()),
  getPublicDiff: vi.fn(),
}));

const sessions: InstanceType<typeof DiffAgentSession>[] = [];
const models: InstanceType<typeof PackageDiffModel>[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) {
    session.stop();
    session[Symbol.dispose]();
  }
  for (const model of models.splice(0)) model[Symbol.dispose]();
  vi.mocked(getPublicDiff).mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function payload(overrides: Partial<PublicDiffResponse> = {}): PublicDiffResponse {
  return {
    ecosystem: "npm",
    packageName: `session-${crypto.randomUUID()}`,
    fromVersion: "1.0.0",
    toVersion: "2.0.0",
    fromPackageJson: null,
    toPackageJson: null,
    diff: [
      { path: "a.js", status: "modified", flags: [] },
      { path: "b.js", status: "added", flags: [] },
    ],
    findings: [],
    packageJsonDiff: summarizePackageJsonDiff(null, null),
    risk: {
      artifactRisk: "low",
      releaseRisk: "low",
      contextRisk: "low",
      releaseFindingCount: 0,
      contextFindingCount: 0,
      unknownFindingCount: 0,
      priorApprovedContextFindingCount: 0,
    },
    textSamplesOmitted: true,
    notices: ["Some evidence was omitted"],
    provenance: [{ label: "Registry", value: "Public registry" }],
    attestation: null,
    displayName: null,
    cachedAt: "2026-10-15T12:00:00Z",
    ...overrides,
  };
}

function evidence(path: string): PublicDiffFileResponse {
  return {
    path,
    before: null,
    after: {
      path,
      size: 42,
      sha256: "sha",
      flags: ["truncated"],
      textSample: "untrusted evidence",
    },
    textSamplesOmitted: true,
  };
}

function pathOf(spec: DiffSpec) {
  return packageDiffPath(spec.ecosystem, spec.packageName, spec.fromVersion, spec.toVersion);
}

function input(data: PublicDiffResponse) {
  return {
    ecosystem: data.ecosystem,
    package: data.packageName,
    from: data.fromVersion,
    to: data.toVersion,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(start = "/diff") {
  let browserPath = start;
  const session = new DiffAgentSession({
    path: () => browserPath,
    origin: () => "https://drydock.example",
  });
  sessions.push(session);
  const route = vi.fn<(path: string) => void>((path) => {
    browserPath = path;
  });
  session.setLocation(browserPath, route);
  return {
    session,
    route,
    get path() {
      return browserPath;
    },
    move(path: string, router: (path: string) => void = route) {
      browserPath = path;
      session.setLocation(path, router);
    },
    attach(data: PublicDiffResponse, seed = data) {
      const model = new PackageDiffModel(
        data.ecosystem,
        data.packageName,
        data.fromVersion,
        data.toVersion,
        seed,
      );
      models.push(model);
      const reveal = vi.fn((path: string, signal: AbortSignal) => model.selectPath(path, signal));
      const detach = session.attach(data, model, reveal);
      return { model, reveal, detach };
    },
  };
}

describe("diff agent session", () => {
  test("hands the canonical response to the matching view once and never repeats the pair fetch", async () => {
    const data = payload({ ecosystem: "pypi", packageName: "demo-pkg" });
    vi.mocked(getPublicDiff).mockResolvedValue(data);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/versions?")) {
        return Response.json({ ...data, versions: [], suggested: { from: "1.0.0", to: "2.0.0" } });
      }
      if (url.includes("/file?")) return Response.json(evidence("b.js"));
      throw new Error("A seeded view must not fetch the pair again");
    });
    vi.stubGlobal("fetch", fetchMock);
    const page = harness();
    let seeded: ReturnType<typeof page.attach> | undefined;
    page.route.mockImplementation((path) => {
      page.move(path);
      expect(
        page.session.takeInitialDiff({ ...data, packageName: "wrong-package" }),
      ).toBeUndefined();
      const initial = page.session.takeInitialDiff(data);
      expect(initial).toBe(data);
      expect(page.session.takeInitialDiff(data)).toBeUndefined();
      seeded = page.attach(data, initial);
    });
    const result = await page.session.compare(
      { ...input(data), package: "Demo.Pkg" },
      new AbortController().signal,
    );
    expect(result).toEqual({ ...data, reviewUrl: `https://drydock.example${pathOf(data)}` });
    expect(page.path).toBe(pathOf(data));
    expect(seeded?.model.diff.peek()).toBe(data);
    await seeded?.model.load();
    expect(getPublicDiff).toHaveBeenCalledExactlyOnceWith(
      "pypi",
      "Demo.Pkg",
      "1.0.0",
      "2.0.0",
      expect.any(AbortSignal),
    );
    expect(
      fetchMock.mock.calls.every(([url]) => url.includes("/versions?") || url.includes("/file?")),
    ).toBe(true);
  });

  test("repeated comparisons use the most recently supplied router", async () => {
    const first = payload();
    const second = payload();
    vi.mocked(getPublicDiff).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const page = harness();
    page.route.mockImplementation((path) => {
      page.move(path);
      page.attach(first, page.session.takeInitialDiff(first));
    });
    await page.session.compare(input(first), new AbortController().signal);
    const latestRoute = vi.fn((path: string) => {
      page.move(path, latestRoute);
      page.attach(second, page.session.takeInitialDiff(second));
    });
    page.session.setLocation(page.path, latestRoute);
    const result = await page.session.compare(input(second), new AbortController().signal);
    expect(page.route).toHaveBeenCalledOnce();
    expect(latestRoute).toHaveBeenCalledExactlyOnceWith(pathOf(second));
    expect(result.reviewUrl).toBe(`https://drydock.example${pathOf(second)}`);
  });

  test("file inspection reuses only the matching visible review and returns its own evidence", async () => {
    const data = payload();
    const page = harness(pathOf(data));
    const attached = page.attach(data);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(evidence("a.js"))),
    );
    const result = await page.session.file(
      { ...input(data), path: "a.js" },
      new AbortController().signal,
    );
    expect(result).toEqual(evidence("a.js"));
    expect(attached.model.selectedPath.peek()).toBe("a.js");
    expect(attached.model.file.peek()).toEqual(evidence("a.js"));
    expect(getPublicDiff).not.toHaveBeenCalled();
    expect(page.route).not.toHaveBeenCalled();
  });

  test("a different requested pair cannot reuse the currently attached review", async () => {
    const old = payload();
    const requested = payload();
    const page = harness(pathOf(old));
    const oldView = page.attach(old);
    vi.mocked(getPublicDiff).mockResolvedValue(requested);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(evidence("a.js"))),
    );
    page.route.mockImplementation((path) => {
      page.move(path);
      page.attach(requested, page.session.takeInitialDiff(requested));
    });
    expect(
      await page.session.file({ ...input(requested), path: "a.js" }, new AbortController().signal),
    ).toEqual(evidence("a.js"));
    expect(getPublicDiff).toHaveBeenCalledOnce();
    expect(oldView.reveal).not.toHaveBeenCalled();
  });

  test("missing files fail before a file fetch", async () => {
    const data = payload();
    const page = harness(pathOf(data));
    const attached = page.attach(data);
    await expect(
      page.session.file({ ...input(data), path: "missing.js" }, new AbortController().signal),
    ).rejects.toMatchObject({ status: 404 });
    expect(attached.reveal).not.toHaveBeenCalled();
    expect(getPublicDiff).not.toHaveBeenCalled();
  });

  test.each(["selection", "route", "view"])(
    "rejects pending file evidence when the %s changes",
    async (change) => {
      const data = payload();
      const page = harness(pathOf(data));
      const attached = page.attach(data);
      const pending = deferred<Response>();
      const started = deferred<void>();
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string) => {
          if (url.includes("path=a.js")) {
            started.resolve();
            return pending.promise;
          }
          return Promise.resolve(Response.json(evidence("b.js")));
        }),
      );
      const selecting = page.session.file(
        { ...input(data), path: "a.js" },
        new AbortController().signal,
      );
      const rejected = expect(selecting).rejects.toMatchObject({ status: 409 });
      await started.promise;
      if (change === "selection") await attached.model.selectPath("b.js");
      if (change === "route") page.move("/docs");
      if (change === "view") {
        attached.detach();
        page.attach(data);
      }
      pending.resolve(Response.json(evidence("a.js")));
      await rejected;
      if (change === "selection") expect(attached.model.file.peek()).toEqual(evidence("b.js"));
      expect(page.route).not.toHaveBeenCalled();
    },
  );

  test("file failures preserve the model's actionable API status and retry delay", async () => {
    const data = payload();
    const page = harness(pathOf(data));
    page.attach(data);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: "rate limit exceeded" },
          { status: 429, headers: { "retry-after": "17" } },
        ),
      ),
    );
    await expect(
      page.session.file({ ...input(data), path: "a.js" }, new AbortController().signal),
    ).rejects.toMatchObject({ status: 429, retryAfterSeconds: 17 });
  });

  test("a failed comparison never routes or clears the current review", async () => {
    const data = payload();
    const page = harness(pathOf(data));
    const attached = page.attach(data);
    const failure = new ApiError("rate limit exceeded", 429);
    vi.mocked(getPublicDiff).mockRejectedValue(failure);
    await expect(page.session.compare(input(payload()), new AbortController().signal)).rejects.toBe(
      failure,
    );
    expect(page.route).not.toHaveBeenCalled();
    expect(attached.model.diff.peek()).toBe(data);
    expect(page.session.viewVersion.peek()).toBe(0);
  });

  test("a cancelled pair fetch cannot route when its backend resolves late", async () => {
    const data = payload();
    const pending = deferred<PublicDiffResponse>();
    vi.mocked(getPublicDiff).mockReturnValue(pending.promise);
    const page = harness();
    const controller = new AbortController();
    const comparing = page.session.compare(input(data), controller.signal);
    controller.abort();
    pending.resolve(data);
    await expect(comparing).rejects.toMatchObject({ name: "AbortError" });
    expect(page.route).not.toHaveBeenCalled();
    expect(page.session.takeInitialDiff(data)).toBeUndefined();
  });

  test("a superseded fetch cannot replace the newer canonical review", async () => {
    const first = payload();
    const latest = payload();
    const pending = deferred<PublicDiffResponse>();
    vi.mocked(getPublicDiff).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(latest);
    const page = harness();
    page.route.mockImplementation((path) => {
      page.move(path);
      page.attach(latest, page.session.takeInitialDiff(latest));
    });
    const firstController = new AbortController();
    const old = page.session.compare(input(first), firstController.signal);
    firstController.abort();
    await page.session.compare(input(latest), new AbortController().signal);
    pending.resolve(first);
    await expect(old).rejects.toMatchObject({ name: "AbortError" });
    expect(page.route).toHaveBeenCalledExactlyOnceWith(pathOf(latest));
    expect(page.path).toBe(pathOf(latest));
  });

  test("navigation away and back while a pair fetch is pending still invalidates it", async () => {
    const data = payload();
    const pending = deferred<PublicDiffResponse>();
    vi.mocked(getPublicDiff).mockReturnValue(pending.promise);
    const page = harness();
    const comparing = page.session.compare(input(data), new AbortController().signal);
    page.move("/docs");
    page.move("/diff");
    pending.resolve(data);
    await expect(comparing).rejects.toMatchObject({ status: 409 });
    expect(page.route).not.toHaveBeenCalled();
  });

  test("waiting for the new keyed view rejects on timeout", async () => {
    vi.useFakeTimers();
    const data = payload();
    vi.mocked(getPublicDiff).mockResolvedValue(data);
    const page = harness();
    const comparing = page.session.compare(input(data), new AbortController().signal);
    const rejected = expect(comparing).rejects.toMatchObject({ status: 409 });
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(page.route).toHaveBeenCalledExactlyOnceWith(pathOf(data));
    expect(vi.getTimerCount()).toBe(0);
  });

  test("stopping the session rejects a pending view attachment and prevents later routing", async () => {
    const data = payload();
    vi.mocked(getPublicDiff).mockResolvedValue(data);
    const page = harness();
    const comparing = page.session.compare(input(data), new AbortController().signal);
    const rejected = expect(comparing).rejects.toMatchObject({ status: 409 });
    await Promise.resolve();
    expect(page.route).toHaveBeenCalledOnce();
    page.session.stop();
    await rejected;
    expect(page.session.takeInitialDiff(data)).toBeUndefined();
    await expect(
      page.session.compare(input(data), new AbortController().signal),
    ).rejects.toMatchObject({ status: 409 });
    expect(getPublicDiff).toHaveBeenCalledOnce();
  });

  test("a view detached before the handoff completes cannot produce a successful comparison", async () => {
    const data = payload();
    vi.mocked(getPublicDiff).mockResolvedValue(data);
    const page = harness();
    page.route.mockImplementation((path) => {
      page.move(path);
      const attached = page.attach(data, page.session.takeInitialDiff(data));
      queueMicrotask(attached.detach);
    });
    const comparing = page.session.compare(input(data), new AbortController().signal);
    await expect(comparing).rejects.toMatchObject({ status: 409 });
  });
});
