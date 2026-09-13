import { afterEach, expect, test, vi } from "vitest";
import { setActiveOrganizationId } from "../src/models/active-organization";
import { PublicationWatchesModel, type PublicationWatch } from "../src/models/publication-watches";

let model: InstanceType<typeof PublicationWatchesModel> | null = null;
const watch: PublicationWatch = {
  id: "watch-1",
  packageName: "@scope/package",
  createdAt: "2026-09-01T00:00:00.000Z",
  lastCheckedAt: null,
  lastError: null,
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  model?.[Symbol.dispose]();
  model = null;
  setActiveOrganizationId(null);
  vi.unstubAllGlobals();
});

test("enrolls a package with no scan history, checks it, and removes its detail", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(json({ watches: [] }))
    .mockResolvedValueOnce(json({ watch }))
    .mockResolvedValueOnce(
      json({
        watch,
        observations: [{ version: "1.0.0", status: "published_without_approval", scanId: null }],
      }),
    )
    .mockResolvedValueOnce(json({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
  model = new PublicationWatchesModel();
  await vi.waitFor(() => expect(model!.loaded.value).toBe(true));
  model.packageName.value = " @scope/package ";
  await model.enroll();
  expect(model.watches.value).toEqual([watch]);
  expect(fetchMock.mock.calls[1]?.[1].body).toBe(JSON.stringify({ packageName: "@scope/package" }));
  expect(model.packageName.value).toBe("");
  await model.show(watch.id, true);
  expect(model.detail.value?.observations[0]?.status).toBe("published_without_approval");
  expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/v1/publication-watches/watch-1/check");
  await model.remove(watch.id);
  expect(model.watches.value).toEqual([]);
  expect(model.detail.value).toBeNull();
});

test("keeps enrollment input and reports a failed request", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(json({ watches: [] }))
      .mockResolvedValueOnce(json({ error: "Package name is invalid" }, 400)),
  );
  model = new PublicationWatchesModel();
  await vi.waitFor(() => expect(model!.loaded.value).toBe(true));
  model.packageName.value = "bad package";
  await model.enroll();
  expect(model.packageName.value).toBe("bad package");
  expect(model.error.value).toBe("Package name is invalid");
  expect(model.busy.value).toBe(false);
});

test("discards pending mutations across A to B to A and clears all organization state", async () => {
  const response = deferred();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(json({ watches: [watch] }))
    .mockReturnValueOnce(response.promise)
    .mockResolvedValue(json({ watches: [] }));
  vi.stubGlobal("fetch", fetchMock);
  setActiveOrganizationId("org-a");
  model = new PublicationWatchesModel();
  await vi.waitFor(() => expect(model!.loaded.value).toBe(true));
  const pending = model.show(watch.id, true);
  setActiveOrganizationId("org-b");
  expect(model.watches.value).toEqual([]);
  expect(model.detail.value).toBeNull();
  setActiveOrganizationId("org-a");
  await vi.waitFor(() => expect(model!.loaded.value).toBe(true));
  response.resolve(json({ watch, observations: [] }));
  await pending;
  expect(model.watches.value).toEqual([]);
  expect(model.detail.value).toBeNull();
  expect(model.busy.value).toBe(false);
});

test("serializes duplicate actions and ignores a response after disposal", async () => {
  const response = deferred();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(json({ watches: [] }))
    .mockReturnValue(response.promise);
  vi.stubGlobal("fetch", fetchMock);
  model = new PublicationWatchesModel();
  await vi.waitFor(() => expect(model!.loaded.value).toBe(true));
  model.packageName.value = "@scope/package";
  const pending = model.enroll();
  await model.enroll();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  model[Symbol.dispose]();
  response.resolve(json({ watch }));
  await pending;
  expect(model.watches.value).toEqual([]);
});
