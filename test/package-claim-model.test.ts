import { afterEach, expect, test, vi } from "vitest";
import { PackageClaimModel } from "../src/models/package-claim";
import { activeOrganizationId, setActiveOrganizationId } from "../src/models/active-organization";

let model: InstanceType<typeof PackageClaimModel> | null = null;
const personal = { id: "personal", name: "Personal", isPersonal: true, role: "owner" };
const team = { id: "team", name: "Release team", isPersonal: false, role: "admin" };
const provisional = { kind: "personal", managementConfirmed: false, canManage: true };
function json(body: unknown) {
  return new Response(JSON.stringify(body));
}
afterEach(() => {
  model?.[Symbol.dispose]();
  model = null;
  setActiveOrganizationId(null);
  vi.unstubAllGlobals();
});
function mockApi(claim: typeof provisional | null = provisional) {
  const writes: Array<{ url: string; body: unknown; headers: unknown }> = [];
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      writes.push({ url: input, body: JSON.parse(String(init.body)), headers: init.headers });
      return json({ managed: true });
    }
    return json(
      input === "/api/v1/organizations"
        ? { organizations: [personal, team] }
        : { claim, destinations: [{ id: team.id, name: team.name }] },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  setActiveOrganizationId(personal.id);
  model = new PackageClaimModel("@scope/package", "https://registry.npmjs.org");
  return { writes, fetchMock };
}
test("defaults to a shared destination and transfers only the claim, without switching organization", async () => {
  const { writes } = mockApi();
  await vi.waitFor(() => expect(model!.loading.value).toBe(false));
  expect(model!.selectedOrganizationId.value).toBe(team.id);
  expect(await model!.choose(true)).toBe("moved");
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    url: "/api/v1/npm-package-claims/@scope/package",
    body: { targetOrganizationId: team.id, registryUrl: "https://registry.npmjs.org" },
  });
  expect(model!.movedTo.value).toMatchObject({ id: team.id, transferred: true });
  expect(activeOrganizationId.value).toBe(personal.id);
});
test("explicit personal selection confirms the claim before enrolling the watch", async () => {
  const { writes } = mockApi();
  await vi.waitFor(() => expect(model!.loading.value).toBe(false));
  model!.selectedOrganizationId.value = personal.id;
  expect(await model!.choose(true)).toBe("watched");
  expect(writes.map((write) => write.body)).toEqual([
    { targetOrganizationId: personal.id, registryUrl: "https://registry.npmjs.org" },
    { packageName: "@scope/package", confirmPersonalOrganization: true },
  ]);
});
test("an unclaimed watch does not acquire a claim, and choosing a team only offers navigation", async () => {
  const { writes } = mockApi(null);
  await vi.waitFor(() => expect(model!.loading.value).toBe(false));
  expect(await model!.choose(true)).toBe("moved");
  expect(writes).toEqual([]);
  expect(model!.movedTo.value?.transferred).toBe(false);
  model!.selectedOrganizationId.value = personal.id;
  expect(await model!.choose(true)).toBe("watched");
  expect(writes).toHaveLength(1);
  expect(writes[0]?.url).toBe("/api/v1/publication-watches");
});
test("an organization switch during confirmation cannot enroll a watch in the destination", async () => {
  const { fetchMock } = mockApi();
  await vi.waitFor(() => expect(model!.loading.value).toBe(false));
  let finish!: () => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = () => resolve(json({ managed: true }));
      }),
  );
  model!.selectedOrganizationId.value = personal.id;
  const request = model!.choose(true);
  setActiveOrganizationId(team.id);
  finish();
  expect(await request).toBeNull();
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/v1/publication-watches")).toBe(false);
  expect(model!.movedTo.value).toBeNull();
});

test.each(["personal", "team"])(
  "committed choice to %s stays successful when its follow-up read fails",
  async (target) => {
    const { fetchMock } = mockApi();
    await vi.waitFor(() => expect(model!.loading.value).toBe(false));
    model!.selectedOrganizationId.value = target;
    fetchMock.mockImplementationOnce(async () => json({ managed: true }));
    fetchMock.mockRejectedValueOnce(new Error("Refresh unavailable"));
    expect(await model!.choose()).toBe(target === "personal" ? "kept" : "moved");
    expect(model!.error.value).toContain("choice was saved");
    if (target === "personal")
      expect(model!.management.value?.claim?.managementConfirmed).toBe(true);
    else expect(model!.movedTo.value).toMatchObject({ id: "team", transferred: true });
  },
);

test("a double-submitted choice sends one transfer", async () => {
  const { writes } = mockApi();
  await vi.waitFor(() => expect(model!.loading.value).toBe(false));
  const [first, second] = await Promise.all([model!.choose(), model!.choose()]);
  expect([first, second]).toEqual(["moved", null]);
  expect(writes).toHaveLength(1);
});

test("a permission denial reads as a sentence, while a conflict keeps the server's reason", async () => {
  const { fetchMock } = mockApi();
  await vi.waitFor(() => expect(model!.loading.value).toBe(false));
  fetchMock.mockImplementationOnce(async () =>
    Response.json({ error: "forbidden" }, { status: 403 }),
  );
  expect(await model!.choose()).toBeNull();
  expect(model!.error.value).toBe("You no longer have permission to manage this package here.");
  fetchMock.mockImplementationOnce(async () =>
    Response.json({ error: "The destination watch budget is full." }, { status: 409 }),
  );
  expect(await model!.choose()).toBeNull();
  expect(model!.error.value).toBe("The destination watch budget is full.");
});

test("an already confirmed personal claim is not confirmed again", async () => {
  const { writes } = mockApi({ ...provisional, managementConfirmed: true });
  await vi.waitFor(() => expect(model!.loading.value).toBe(false));
  model!.selectedOrganizationId.value = personal.id;
  expect(await model!.choose()).toBe("kept");
  expect(writes).toEqual([]);
  expect(await model!.choose(true)).toBe("watched");
  expect(writes.map((write) => write.url)).toEqual(["/api/v1/publication-watches"]);
});

test("an initial read that finishes after an organization switch is discarded", async () => {
  const { fetchMock } = mockApi();
  await vi.waitFor(() => expect(model!.loading.value).toBe(false));
  model?.[Symbol.dispose]();
  const pending: Array<() => void> = [];
  fetchMock.mockImplementation(
    (input: string) =>
      new Promise<Response>((resolve) => {
        const body =
          input === "/api/v1/organizations"
            ? { organizations: [personal, team] }
            : { claim: provisional, destinations: [{ id: team.id, name: team.name }] };
        pending.push(() => resolve(json(body)));
      }),
  );
  model = new PackageClaimModel("@scope/package");
  const stale = pending.splice(0);
  setActiveOrganizationId(team.id);
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  for (const resolve of pending.splice(0)) resolve();
  await vi.waitFor(() => expect(model!.loading.value).toBe(false));
  for (const resolve of stale) resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(model!.organization.value?.id).toBe(team.id);
  expect(model!.selectedOrganizationId.value).toBe(team.id);
});
