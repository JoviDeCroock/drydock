import { signal } from "@preact/signals";
import { afterEach, expect, test, vi } from "vitest";
import { DependencyReadinessModel } from "../src/models/dependency-readiness";

let model: InstanceType<typeof DependencyReadinessModel> | null = null;
afterEach(() => {
  model?.[Symbol.dispose]();
  model = null;
  vi.unstubAllGlobals();
});

const checked = (nextOffset?: number) => ({
  status: "checked",
  declared: 50,
  notRegistry: 0,
  satisfiedByRelease: 0,
  credentialed: true,
  issues: [],
  ...(nextOffset === undefined ? {} : { nextOffset }),
});

test("a re-check resumes from the offset the previous check returned", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(checked(40))))
    .mockResolvedValueOnce(new Response(JSON.stringify(checked())))
    .mockResolvedValueOnce(new Response(JSON.stringify(checked())));
  vi.stubGlobal("fetch", fetchMock);
  model = new DependencyReadinessModel("scan/1", signal(true));
  await vi.waitFor(() => expect(model!.result.value).not.toBeNull());

  await model.refresh();
  await model.refresh();

  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    "/api/v1/scans/scan%2F1/dependency-readiness",
    "/api/v1/scans/scan%2F1/dependency-readiness?offset=40",
    "/api/v1/scans/scan%2F1/dependency-readiness",
  ]);
});
