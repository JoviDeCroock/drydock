import { afterEach, describe, expect, test, vi } from "vitest";
import { setActiveOrganizationId } from "../src/models/active-organization";
import { ScanBatchApprovalModel } from "../src/models/scan-batch-approval";
import { npmStagedPackagesListUrlFor } from "../src/lib/npm-staged-url";
import { jsonResponse } from "./helpers/fetch-stub";

let model: InstanceType<typeof ScanBatchApprovalModel> | null = null;

function candidate(id: string) {
  return {
    id,
    packageName: `@batch/${id}`,
    stagedVersion: "1.0.0",
    registryUrl: "https://registry.npmjs.org",
    releaseFindingCount: 0,
    createdAt: "2026-09-28T00:00:00.000Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("ScanBatchApprovalModel", () => {
  afterEach(() => {
    model?.[Symbol.dispose]();
    model = null;
    setActiveOrganizationId(null);
    vi.unstubAllGlobals();
  });

  test("loads the candidates and offers nothing when the list cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ scans: [candidate("a"), candidate("b")], more: true }),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: "boom" }), { status: 500 })),
    );
    setActiveOrganizationId("org-a");
    model = new ScanBatchApprovalModel();

    await model.refresh();
    expect(model.candidates.value.map((scan) => scan.id)).toEqual(["a", "b"]);
    expect(model.more.value).toBe(true);

    await model.refresh();
    expect(model.candidates.value).toEqual([]);
    expect(model.more.value).toBe(false);
  });

  test("drops one organization's candidates on a switch and discards its late answer", async () => {
    const late = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(late.promise));
    setActiveOrganizationId("org-a");
    model = new ScanBatchApprovalModel();
    model.candidates.value = [candidate("stale")];

    const pending = model.refresh();
    setActiveOrganizationId("org-b");
    expect(model.candidates.value).toEqual([]);

    late.resolve(jsonResponse({ scans: [candidate("a")], more: false }));
    await pending;
    expect(model.candidates.value).toEqual([]);
  });

  test("posts the chosen ids with the reason and reports a failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ approved: [{ id: "a" }], skipped: ["b"] }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "nope" }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    setActiveOrganizationId("org-a");
    model = new ScanBatchApprovalModel();

    const result = await model.approve(["a", "b"], "monorepo release");
    expect(result).toEqual({ approved: [{ id: "a" }], skipped: ["b"] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/scans/batch-approval");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      scanIds: ["a", "b"],
      reason: "monorepo release",
    });
    expect(model.saving.value).toBe(false);

    expect(await model.approve(["a"], null)).toBeNull();
    expect(model.error.value).toBe("nope");
  });
});

test("an approval drops what it approved, and a list read that started before it", async () => {
  const stale = deferred<Response>();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse({ scans: [candidate("a"), candidate("b")], more: false }))
    .mockReturnValueOnce(stale.promise)
    .mockResolvedValueOnce(jsonResponse({ approved: [{ id: "a" }], skipped: [] }))
    .mockResolvedValueOnce(jsonResponse({ scans: [candidate("b")], more: false }));
  vi.stubGlobal("fetch", fetchMock);
  setActiveOrganizationId("org-a");
  model = new ScanBatchApprovalModel();

  await model.refresh();
  const beforeApproval = model.refresh();
  await model.approve(["a"], null);
  expect(model.candidates.value.map((scan) => scan.id)).toEqual(["b"]);

  stale.resolve(jsonResponse({ scans: [candidate("a"), candidate("b")], more: false }));
  await beforeApproval;
  expect(model.candidates.value.map((scan) => scan.id)).toEqual(["b"]);

  // A read after the approval starts fresh instead of joining the stale one.
  await model.refresh();
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

test("the npm staged-packages link is offered only when every stage is on public npm", () => {
  expect(npmStagedPackagesListUrlFor([candidate("a"), { registryUrl: null }])).toBe(
    "https://www.npmjs.com/settings/~/staged-packages/",
  );
  expect(
    npmStagedPackagesListUrlFor([candidate("a"), { registryUrl: "https://npm.internal.example" }]),
  ).toBeNull();
  expect(npmStagedPackagesListUrlFor([])).toBeNull();
});
