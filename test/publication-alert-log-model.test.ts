import { afterEach, expect, test, vi } from "vitest";
import { alertLogMetaLine } from "../src/features/publication-monitor/copy";
import { setActiveOrganizationId } from "../src/models/active-organization";
import {
  PublicationAlertLogModel,
  publicationAlertLogApiPath,
  type PublicationAlertLogEntry,
} from "../src/models/publication-alert-log";

let model: InstanceType<typeof PublicationAlertLogModel> | null = null;

const entry: PublicationAlertLogEntry = {
  packageName: "@scope/package",
  version: "1.0.1",
  status: "published_without_approval",
  createdAt: "2026-09-02T00:00:00.000Z",
  acknowledgedAt: null,
  reviewScanId: null,
  resolution: null,
  resolvedAt: null,
  resolutionBadge: null,
  watched: true,
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

test("loads the organization's log on refresh, and only the latest refresh lands", async () => {
  let releaseFirst!: (response: Response) => void;
  const fetchMock = vi
    .fn()
    .mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        releaseFirst = resolve;
      }),
    )
    .mockResolvedValueOnce(json({ alerts: [entry], moreAlerts: true }));
  vi.stubGlobal("fetch", fetchMock);
  model = new PublicationAlertLogModel();
  expect(fetchMock).not.toHaveBeenCalled();

  const stale = model.refresh();
  await model.refresh();
  releaseFirst(json({ alerts: [], moreAlerts: false }));
  await stale;
  expect(fetchMock.mock.calls[0]?.[0]).toBe(publicationAlertLogApiPath);
  expect(model.alerts.value).toEqual([entry]);
  expect(model.more.value).toBe(true);
  expect(model.loaded.value).toBe(true);
});

test("an organization switch clears the previous organization's log", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ alerts: [entry], moreAlerts: false })));
  model = new PublicationAlertLogModel();
  await model.refresh();
  expect(model.alerts.value).toHaveLength(1);
  setActiveOrganizationId("org-2");
  expect(model.alerts.value).toEqual([]);
  expect(model.loaded.value).toBe(false);
});

test("a failed load says why and keeps nothing stale", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "nope" }, 500)));
  model = new PublicationAlertLogModel();
  await model.refresh();
  expect(model.error.value).toBeTruthy();
  expect(model.alerts.value).toEqual([]);
  expect(model.loaded.value).toBe(true);
});

test("the log line says where each unapproved publish stands", () => {
  expect(alertLogMetaLine(entry)).toMatch(/^raised .+ · not acknowledged$/);
  expect(
    alertLogMetaLine({ ...entry, acknowledgedAt: "2026-09-03T00:00:00.000Z", watched: false }),
  ).toMatch(/^raised .+ · acknowledged .+ · no longer watched$/);
  expect(
    alertLogMetaLine({
      ...entry,
      acknowledgedAt: "2026-09-03T00:00:00.000Z",
      resolution: "approved_after_release",
      resolvedAt: "2026-09-04T00:00:00.000Z",
    }),
  ).toMatch(/^raised .+ · decided .+$/);
});
