import { afterEach, expect, test, vi } from "vitest";
import { NpmConnectionModel } from "../src/models/npm-connection";
import { setActiveOrganizationId } from "../src/models/active-organization";

let model: InstanceType<typeof NpmConnectionModel> | null = null;
const connection = {
  id: "connection",
  organizationId: "personal",
  label: "npm",
  registryUrl: "https://registry.npmjs.org",
  validationStatus: "valid",
  personalOrganizationConfirmedAt: 123,
};
function json(body: unknown) {
  return new Response(JSON.stringify(body));
}
afterEach(() => {
  model?.[Symbol.dispose]();
  model = null;
  setActiveOrganizationId(null);
  vi.unstubAllGlobals();
});
test("explicit personal npm setup passes consent to saving and validation", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(json({ connection }))
    .mockResolvedValueOnce(json({ connection, validation: { ok: true } }));
  vi.stubGlobal("fetch", fetchMock);
  setActiveOrganizationId("personal");
  model = new NpmConnectionModel();
  model.token.value = "npm_fake";
  await model.save(true);
  expect(
    fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).confirmPersonalOrganization),
  ).toEqual([true, true]);
  expect(model.connection.value?.personalOrganizationConfirmedAt).toBe(123);
  expect(model.token.value).toBe("");
});
test("switching organizations during save cannot validate the new organization's credentials", async () => {
  let finish!: () => void;
  const fetchMock = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = () => resolve(json({ connection }));
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  setActiveOrganizationId("personal");
  model = new NpmConnectionModel();
  model.token.value = "npm_fake";
  const save = model.save(true);
  setActiveOrganizationId("team");
  finish();
  await save;
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(model.connection.value).toBeNull();
});
test("an older organization load cannot replace the current connection", async () => {
  let finish!: () => void;
  const fetchMock = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = () => resolve(json({ connection }));
        }),
    )
    .mockResolvedValueOnce(json({ connection: { ...connection, organizationId: "team" } }));
  vi.stubGlobal("fetch", fetchMock);
  setActiveOrganizationId("personal");
  model = new NpmConnectionModel();
  const personalLoad = model.load();
  setActiveOrganizationId("team");
  await model.load();
  finish();
  await personalLoad;
  expect(model.connection.value?.organizationId).toBe("team");
});
test("a response from an earlier visit to the same organization is ignored", async () => {
  const pending: Array<(body: unknown) => void> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          pending.push((body) => resolve(json(body)));
        }),
    ),
  );
  setActiveOrganizationId("personal");
  model = new NpmConnectionModel();
  const first = model.load();
  setActiveOrganizationId("team");
  const second = model.load();
  setActiveOrganizationId("personal");
  const third = model.load();
  pending[2]!({ connection: { ...connection, label: "current" } });
  await third;
  expect(model.loaded.value).toBe(true);
  pending[0]!({ connection: { ...connection, label: "stale" } });
  pending[1]!({ connection: { ...connection, organizationId: "team" } });
  await Promise.all([first, second]);
  expect(model.connection.value?.label).toBe("current");
});
test("loaded waits for the current organization's response after a mid-load switch", async () => {
  const pending: Array<(body: unknown) => void> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          pending.push((body) => resolve(json(body)));
        }),
    ),
  );
  setActiveOrganizationId("personal");
  model = new NpmConnectionModel();
  const first = model.load();
  setActiveOrganizationId("team");
  pending[0]!({ connection });
  await first;
  expect(model.loaded.value).toBe(false);
  expect(model.connection.value).toBeNull();
  const second = model.load();
  pending[1]!({ connection: null });
  await second;
  expect(model.loaded.value).toBe(true);
});
test("confirming the personal workspace never contacts npm validation and keeps the typed token", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(json({ connection }));
  vi.stubGlobal("fetch", fetchMock);
  setActiveOrganizationId("personal");
  model = new NpmConnectionModel();
  model.token.value = "npm_typed";
  expect(await model.confirmPersonalOrganization()).toBe(true);
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    "/api/v1/npm-connection/personal-confirmation",
  ]);
  expect(model.connection.value?.personalOrganizationConfirmedAt).toBe(123);
  expect(model.token.value).toBe("npm_typed");
  expect(model.busy.value).toBe(false);
});
