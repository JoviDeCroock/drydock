import { afterEach, expect, test, vi } from "vitest";
import { setActiveOrganizationId } from "../src/models/active-organization";
import { PublicationWatchesModel, type PublicationWatch } from "../src/models/publication-watches";

let model: InstanceType<typeof PublicationWatchesModel> | null = null;
const watch: PublicationWatch = {
  id: "watch-1",
  packageName: "@scope/package",
  source: "manual",
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
    .mockResolvedValueOnce(json({ watches: [], autoEnrollment: { deferred: 0, suggestions: [] } }))
    .mockResolvedValueOnce(json({ watch }))
    .mockResolvedValueOnce(
      json({ watches: [watch], autoEnrollment: { deferred: 0, suggestions: [] } }),
    )
    .mockResolvedValueOnce(
      json({
        watch,
        observations: [{ version: "1.0.0", status: "published_without_approval", scanId: null }],
      }),
    )
    .mockResolvedValueOnce(json({ ok: true }))
    .mockResolvedValueOnce(json({ watches: [], autoEnrollment: { deferred: 0, suggestions: [] } }));
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
  expect(fetchMock.mock.calls[3]?.[0]).toBe("/api/v1/publication-watches/watch-1/check");
  await model.remove(watch.id);
  expect(model.watches.value).toEqual([]);
  expect(model.detail.value).toBeNull();
});

test("keeps enrollment input and reports a failed request", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        json({ watches: [], autoEnrollment: { deferred: 0, suggestions: [] } }),
      )
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
    .mockResolvedValueOnce(
      json({ watches: [watch], autoEnrollment: { deferred: 0, suggestions: [] } }),
    )
    .mockReturnValueOnce(response.promise)
    .mockResolvedValue(json({ watches: [], autoEnrollment: { deferred: 0, suggestions: [] } }));
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
    .mockResolvedValueOnce(json({ watches: [], autoEnrollment: { deferred: 0, suggestions: [] } }))
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

test("shows deferred enrollment and gate suggestions, and opts in without clearing typed input", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      json({
        watches: [],
        autoEnrollment: {
          deferred: 3,
          suggestions: [{ packageName: "@scope/package" }, { packageName: "@scope/other" }],
        },
      }),
    )
    .mockResolvedValueOnce(json({ watch }))
    .mockResolvedValueOnce(
      json({
        watches: [watch],
        autoEnrollment: { deferred: 3, suggestions: [{ packageName: "@scope/other" }] },
      }),
    );
  vi.stubGlobal("fetch", fetchMock);
  model = new PublicationWatchesModel();
  await vi.waitFor(() => expect(model!.loaded.value).toBe(true));
  expect(model.autoEnrollment.value.deferred).toBe(3);
  expect(model.autoEnrollment.value.suggestions).toHaveLength(2);
  model.packageName.value = "another-package";
  await model.enroll("@scope/package");
  expect(JSON.parse(fetchMock.mock.calls[1]?.[1].body)).toEqual({ packageName: "@scope/package" });
  expect(model.watches.value[0]?.source).toBe("manual");
  expect(model.autoEnrollment.value.suggestions).toEqual([{ packageName: "@scope/other" }]);
  expect(model.packageName.value).toBe("another-package");
});

test("clears old organization enrollment metadata and ignores an old list response", async () => {
  const response = deferred();
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        json({
          watches: [watch],
          autoEnrollment: { deferred: 2, suggestions: [{ packageName: "private-context" }] },
        }),
      )
      .mockReturnValueOnce(response.promise)
      .mockResolvedValue(json({ watches: [], autoEnrollment: { deferred: 0, suggestions: [] } })),
  );
  setActiveOrganizationId("org-a");
  model = new PublicationWatchesModel();
  await vi.waitFor(() => expect(model!.loaded.value).toBe(true));
  const oldRequest = model.refresh();
  setActiveOrganizationId("org-b");
  expect(model.autoEnrollment.value).toEqual({ deferred: 0, suggestions: [] });
  response.resolve(
    json({
      watches: [watch],
      autoEnrollment: { deferred: 99, suggestions: [{ packageName: "private-context" }] },
    }),
  );
  await oldRequest;
  await vi.waitFor(() => expect(model!.loaded.value).toBe(true));
  expect(model.autoEnrollment.value).toEqual({ deferred: 0, suggestions: [] });
});

test("refreshes again when new review history arrives during a pending list request", async () => {
  const response = deferred();
  const fetchMock = vi
    .fn()
    .mockReturnValueOnce(response.promise)
    .mockResolvedValueOnce(
      json({
        watches: [{ ...watch, source: "staged_discovery" }],
        autoEnrollment: { deferred: 0, suggestions: [] },
      }),
    );
  vi.stubGlobal("fetch", fetchMock);
  model = new PublicationWatchesModel();
  await model.refresh();
  await model.refresh();
  response.resolve(json({ watches: [], autoEnrollment: { deferred: 0, suggestions: [] } }));
  await vi.waitFor(() => expect(model!.watches.value).toHaveLength(1));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(model.watches.value[0]?.source).toBe("staged_discovery");
});

test("refreshes after stopping a watch so deferred candidates and warnings stay current", async () => {
  const other = {
    ...watch,
    id: "watch-2",
    packageName: "other-package",
    source: "published_history",
  };
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        json({ watches: [watch], autoEnrollment: { deferred: 1, suggestions: [] } }),
      )
      .mockResolvedValueOnce(json({ deleted: true }))
      .mockResolvedValueOnce(
        json({ watches: [other], autoEnrollment: { deferred: 0, suggestions: [] } }),
      ),
  );
  model = new PublicationWatchesModel();
  await vi.waitFor(() => expect(model!.loaded.value).toBe(true));
  await model.remove(watch.id);
  expect(model.watches.value).toEqual([other]);
  expect(model.autoEnrollment.value.deferred).toBe(0);
});

test("keeps fresh checked observations through a queued list refresh until that watch disappears", async () => {
  const response = deferred();
  const checkedWatch = { ...watch, lastCheckedAt: "2026-09-13T12:00:00.000Z" };
  const observations = [
    {
      version: "1.0.0",
      publishedAt: "2026-09-13T11:00:00.000Z",
      firstSeenAt: "2026-09-13T12:00:00.000Z",
      checkedAt: "2026-09-13T12:00:00.000Z",
      status: "published_without_approval",
      scanId: null,
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        json({ watches: [watch], autoEnrollment: { deferred: 0, suggestions: [] } }),
      )
      .mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce(
        json({ watches: [checkedWatch], autoEnrollment: { deferred: 0, suggestions: [] } }),
      )
      .mockResolvedValueOnce(
        json({ watches: [], autoEnrollment: { deferred: 0, suggestions: [] } }),
      ),
  );
  model = new PublicationWatchesModel();
  await vi.waitFor(() => expect(model!.loaded.value).toBe(true));
  const checking = model.show(watch.id, true);
  await model.refresh();
  response.resolve(json({ watch: checkedWatch, observations }));
  await checking;
  expect(model.detail.value).toEqual({ watch: checkedWatch, observations });
  await model.refresh();
  expect(model.detail.value).toBeNull();
});
