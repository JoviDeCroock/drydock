import { afterEach, describe, expect, test, vi } from "vitest";
import {
  getPublicDiff,
  getPublicDiffVersions,
  PackageDiffModel,
  type PublicDiffFileResponse,
  type PublicDiffResponse,
} from "../src/models/package-diff";
import { ApiError } from "../src/models/api";
import { activeOrganizationId, pinnedOrganizationId } from "../src/models/active-organization";
import { summarizePackageJsonDiff } from "../server/lib/review/serialize";

const models: InstanceType<typeof PackageDiffModel>[] = [];

function payload(): PublicDiffResponse {
  return {
    ecosystem: "npm",
    packageName: `agent-${crypto.randomUUID()}`,
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
    textSamplesOmitted: false,
    notices: [],
    provenance: [],
    attestation: null,
    displayName: null,
    cachedAt: "2026-10-15T12:00:00Z",
  };
}

function file(path: string): PublicDiffFileResponse {
  return {
    path,
    before: null,
    after: { path, flags: ["truncated"], size: 40, sha256: "sha", textSample: "bounded evidence" },
    textSamplesOmitted: true,
  };
}

function model(data: PublicDiffResponse, seeded = true) {
  const instance = new PackageDiffModel(
    data.ecosystem,
    data.packageName,
    data.fromVersion,
    data.toVersion,
    seeded ? data : undefined,
  );
  models.push(instance);
  return instance;
}

function json(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), init);
}

function versions(data: PublicDiffResponse) {
  return {
    ecosystem: data.ecosystem,
    packageName: data.packageName,
    displayName: null,
    versions: [],
    suggested: { from: data.fromVersion, to: data.toVersion },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  for (const instance of models.splice(0)) instance[Symbol.dispose]();
  activeOrganizationId.value = null;
  pinnedOrganizationId.value = null;
  vi.unstubAllGlobals();
});

describe("public diff model agent actions", () => {
  test("a seeded review renders immediately and metadata loading never repeats the pair request", async () => {
    const data = payload();
    const fetchMock = vi.fn(async (input: string) =>
      input.includes("/versions?")
        ? json(versions(data))
        : json(file(new URL(input, "http://test").searchParams.get("path") ?? "")),
    );
    vi.stubGlobal("fetch", fetchMock);
    const instance = model(data);
    expect(instance.diff.peek()).toBe(data);
    expect(instance.loading.peek()).toBe(false);
    await Promise.all([instance.load(), instance.load()]);
    await instance.load();
    expect(instance.versions.peek()).toEqual(versions(data));
    expect(instance.selectedPath.peek()).toBe("b.js");
    expect(
      fetchMock.mock.calls.filter(
        ([url]) => !url.includes("/versions?") && !url.includes("/file?"),
      ),
    ).toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([url]) => url.includes("/file?"))).toHaveLength(1);
  });

  test("a file picked while metadata loads is not replaced by the default selection", async () => {
    const data = payload();
    const listing = deferred<Response>();
    const fetchMock = vi.fn((input: string) =>
      input.includes("/versions?") ? listing.promise : Promise.resolve(json(file("b.js"))),
    );
    vi.stubGlobal("fetch", fetchMock);
    const instance = model(data);
    const loaded = instance.load();
    await instance.selectPath("b.js");
    listing.resolve(json(versions(data)));
    await loaded;
    expect(instance.selectedPath.peek()).toBe("b.js");
    expect(instance.file.peek()?.path).toBe("b.js");
    expect(fetchMock.mock.calls.filter(([url]) => url.includes("/file?"))).toHaveLength(1);
  });

  test("overlapping selections deduplicate file reads and return each caller's own evidence", async () => {
    const a = deferred<Response>();
    const b = deferred<Response>();
    const fetchMock = vi.fn((input: string) =>
      new URL(input, "http://test").searchParams.get("path") === "a.js" ? a.promise : b.promise,
    );
    vi.stubGlobal("fetch", fetchMock);
    const instance = model(payload());
    const firstA = instance.selectPath("a.js");
    const secondA = instance.selectPath("a.js");
    const selectedB = instance.selectPath("b.js");
    b.resolve(json(file("b.js")));
    await expect(selectedB).resolves.toEqual(file("b.js"));
    a.resolve(json(file("a.js")));
    await expect(firstA).resolves.toEqual(file("a.js"));
    await expect(secondA).resolves.toEqual(file("a.js"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(instance.selectedPath.peek()).toBe("b.js");
    expect(instance.file.peek()).toEqual(file("b.js"));
    expect(instance.fileLoading.peek()).toBe(false);
    await expect(instance.selectPath("a.js")).resolves.toEqual(file("a.js"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("returning to a pending file reuses its request while a late intervening file cannot overwrite it", async () => {
    const a = deferred<Response>();
    const b = deferred<Response>();
    const fetchMock = vi.fn((input: string) =>
      input.includes("path=a.js") ? a.promise : b.promise,
    );
    vi.stubGlobal("fetch", fetchMock);
    const instance = model(payload());
    const firstA = instance.selectPath("a.js");
    const selectedB = instance.selectPath("b.js");
    const lastA = instance.selectPath("a.js");
    a.resolve(json(file("a.js")));
    await Promise.all([firstA, lastA]);
    b.resolve(json(file("b.js")));
    await selectedB;
    expect(instance.selectedPath.peek()).toBe("a.js");
    expect(instance.file.peek()?.path).toBe("a.js");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("failed evidence stays unavailable with retry metadata and a retry can recover", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({ error: "rate limit exceeded" }, { status: 429, headers: { "retry-after": "17" } }),
      )
      .mockResolvedValueOnce(json(file("a.js")));
    vi.stubGlobal("fetch", fetchMock);
    const instance = model(payload());
    await expect(instance.selectPath("a.js")).resolves.toBeNull();
    expect(instance.fileFailure.peek()).toBeInstanceOf(ApiError);
    expect(instance.fileFailure.peek()).toMatchObject({ status: 429, retryAfterSeconds: 17 });
    expect(instance.fileError.peek()).toBe("rate limit exceeded");
    expect(instance.file.peek()).toBeNull();
    await expect(instance.selectPath("a.js")).resolves.toEqual(file("a.js"));
    expect(instance.fileFailure.peek()).toBeNull();
    expect(instance.fileError.peek()).toBeNull();
  });

  test("cancelled file inspection settles before the shared response and leaves explicit unavailable evidence", async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn(() => pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    const instance = model(payload());
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(instance.selectPath("a.js", cancelled.signal)).resolves.toBeNull();
    expect(instance.selectedPath.peek()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    const controller = new AbortController();
    const selected = instance.selectPath("a.js", controller.signal);
    controller.abort();
    await expect(selected).resolves.toBeNull();
    expect(instance.fileLoading.peek()).toBe(false);
    expect(instance.fileError.peek()).toBe("File inspection cancelled.");
    expect(instance.file.peek()).toBeNull();
    pending.resolve(json(file("a.js")));
  });

  test("cancelling an agent file read does not cancel the same pending file selected by a user", async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn(() => pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    const instance = model(payload());
    const controller = new AbortController();
    const agent = instance.selectPath("a.js", controller.signal);
    const user = instance.selectPath("a.js");
    controller.abort();
    await expect(agent).resolves.toBeNull();
    expect(instance.fileLoading.peek()).toBe(true);
    expect(instance.fileError.peek()).toBeNull();
    pending.resolve(json(file("a.js")));
    await expect(user).resolves.toEqual(file("a.js"));
    expect(instance.file.peek()).toEqual(file("a.js"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("pair, version, and file requests omit cookies and organization headers", async () => {
    const data = payload();
    const fetchMock = vi.fn(async (input: string, _init: RequestInit) =>
      input.includes("/versions?")
        ? json(versions(data))
        : input.includes("/file?")
          ? json(file("a.js"))
          : json(data),
    );
    vi.stubGlobal("fetch", fetchMock);
    activeOrganizationId.value = "private-organization";
    pinnedOrganizationId.value = "private-organization";
    const controller = new AbortController();
    await getPublicDiff("npm", data.packageName, "1.0.0", "2.0.0", controller.signal);
    await getPublicDiffVersions("npm", data.packageName);
    await model(data).selectPath("a.js");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.credentials).toBe("omit");
      const headers = new Headers(init.headers);
      expect(headers.get("x-organization-id")).toBeNull();
      expect(headers.get("x-organization-strict")).toBeNull();
      expect(headers.get("authorization")).toBeNull();
    }
  });

  test("disposing a route cancels its pair load and prevents late file writes", async () => {
    const data = payload();
    const pair = deferred<Response>();
    const picked = deferred<Response>();
    const fetchMock = vi.fn((input: string, _init: RequestInit) =>
      input.includes("/versions?")
        ? Promise.resolve(json(versions(data)))
        : input.includes("/file?")
          ? picked.promise
          : pair.promise,
    );
    vi.stubGlobal("fetch", fetchMock);
    const instance = model(data, false);
    const loaded = instance.load();
    const selected = instance.selectPath("b.js");
    const pairSignal = fetchMock.mock.calls.find(
      ([url]) => !url.includes("/versions?") && !url.includes("/file?"),
    )?.[1].signal;
    instance[Symbol.dispose]();
    expect(pairSignal?.aborted).toBe(true);
    pair.resolve(json(data));
    picked.resolve(json(file("b.js")));
    await loaded;
    await expect(selected).resolves.toBeNull();
    expect(instance.diff.peek()).toBeNull();
    expect(instance.file.peek()).toBeNull();
  });
});
