import { afterEach, expect, test, vi } from "vitest";
import { setActiveOrganizationId } from "../src/models/active-organization";
import {
  PackagePublicationModel,
  packagePublicationApiPath,
  type PackagePublication,
} from "../src/models/package-publication";
import type { PublicationWatch } from "../src/models/publication-watches";

let model: InstanceType<typeof PackagePublicationModel> | null = null;

const watch: PublicationWatch = {
  id: "watch-1",
  organizationId: "org-1",
  packageName: "@scope/package",
  source: "manual",
  createdAt: "2026-09-01T00:00:00.000Z",
  lastCheckedAt: null,
  lastError: null,
  unresolvedAlertCount: 1,
  releaseCount: 1,
  coverageGap: null,
  coverageGapSince: null,
  distTagsCheckedAt: null,
  unverifiedReleaseCount: 0,
};
const alert = {
  id: "obs-1",
  version: "1.0.0",
  status: "published_without_approval" as const,
  reason: null,
  scanId: null,
  previousVersion: "0.9.0",
  distTags: ["latest"],
  publishedAt: "2026-09-02T00:00:00.000Z",
  firstSeenAt: "2026-09-02T00:00:00.000Z",
  checkedAt: "2026-09-02T00:00:00.000Z",
  acknowledgedAt: null,
  coverageGap: false,
};
const watched: PackagePublication = {
  packageName: "@scope/package",
  watch,
  observations: [alert],
  alerts: [],
  moreAlerts: false,
  enrollment: { state: "watched" },
  viewer: { canStop: false },
};
const notWatched: PackagePublication = {
  ...watched,
  watch: null,
  observations: [],
  enrollment: { state: "stopped", stoppedAt: "2026-09-03T00:00:00.000Z" },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  model?.[Symbol.dispose]();
  model = null;
  setActiveOrganizationId(null);
  vi.unstubAllGlobals();
});

test("reads one package with its scoped name kept readable in the path", () => {
  expect(packagePublicationApiPath("@scope/package")).toBe(
    "/api/v1/publication-watches/packages/@scope/package",
  );
});

test("loads the watch, acknowledges an alert in place and mirrors the stop permission", async () => {
  const acknowledged = { ...alert, acknowledgedAt: "2026-09-04T00:00:00.000Z" };
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(json(watched))
    .mockResolvedValueOnce(
      json({ watch: { ...watch, unresolvedAlertCount: 0 }, observations: [acknowledged] }),
    );
  vi.stubGlobal("fetch", fetchMock);
  model = new PackagePublicationModel("@scope/package");
  await vi.waitFor(() => expect(model!.loaded.value).toBe(true));
  expect(model.publication.value?.watch?.id).toBe("watch-1");
  expect(model.canStop.value).toBe(false);
  await model.acknowledge("obs-1");
  expect(fetchMock.mock.calls[1]?.[0]).toBe(
    "/api/v1/publication-watches/watch-1/observations/obs-1/acknowledge",
  );
  expect(model.publication.value).toMatchObject({
    watch: { unresolvedAlertCount: 0 },
    observations: [{ acknowledgedAt: "2026-09-04T00:00:00.000Z" }],
    enrollment: { state: "watched" },
    viewer: { canStop: false },
  });
});

test("starts and stops a watch, re-reading the package state after each", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(json(notWatched))
    .mockResolvedValueOnce(json({ watch }, 201))
    .mockResolvedValueOnce(json({ ...watched, viewer: { canStop: true } }))
    .mockResolvedValueOnce(json({ deleted: true }))
    .mockResolvedValueOnce(json(notWatched));
  vi.stubGlobal("fetch", fetchMock);
  model = new PackagePublicationModel("@scope/package");
  await vi.waitFor(() => expect(model!.loaded.value).toBe(true));
  expect(model.publication.value?.enrollment.state).toBe("stopped");
  await model.start();
  expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
    method: "POST",
    body: JSON.stringify({ packageName: "@scope/package" }),
  });
  expect(model.publication.value?.watch?.id).toBe("watch-1");
  await model.stop();
  expect(fetchMock.mock.calls[3]?.[0]).toBe("/api/v1/publication-watches/watch-1");
  expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({ method: "DELETE" });
  expect(model.publication.value?.watch).toBeNull();
});

test("an organization switch discards the previous organization's response", async () => {
  let resolveFirst!: (response: Response) => void;
  const fetchMock = vi
    .fn()
    .mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveFirst = resolve;
      }),
    )
    .mockResolvedValueOnce(json(notWatched));
  vi.stubGlobal("fetch", fetchMock);
  setActiveOrganizationId("org-a");
  model = new PackagePublicationModel("@scope/package");
  setActiveOrganizationId("org-b");
  await vi.waitFor(() => expect(model!.loaded.value).toBe(true));
  resolveFirst(json(watched));
  await Promise.resolve();
  expect(model.publication.value?.watch).toBeNull();
});

test("reports a failed read", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ error: "forbidden" }, 403)));
  model = new PackagePublicationModel("@scope/package");
  await vi.waitFor(() => expect(model!.error.value).toBe("forbidden"));
  expect(model.publication.value).toBeNull();
});
