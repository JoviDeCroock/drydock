import { afterEach, expect, test, vi } from "vitest";
import { PackageClaimModel, managementChoicePending } from "../src/models/package-claim";
import { activeOrganizationId, setActiveOrganizationId } from "../src/models/active-organization";

let model: InstanceType<typeof PackageClaimModel> | null = null;
const personal = { id: "personal", name: "Personal", isPersonal: true, role: "owner" };
const team = { id: "team", name: "Release team", isPersonal: false, role: "admin" };
const provisional = { kind: "personal", managementConfirmed: false, canManage: true } as const;
type Claim = {
  kind: "personal" | "organization";
  managementConfirmed: boolean;
  canManage: boolean;
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
function mockApi(
  claim: Claim | null = provisional,
  destinations = [{ id: team.id, name: team.name }],
) {
  const writes: Array<{ url: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      writes.push({ url: input, body: JSON.parse(String(init.body)) });
      return json({ managed: true });
    }
    return json(
      input === "/api/v1/organizations"
        ? { organizations: [personal, team] }
        : { claim, destinations },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  setActiveOrganizationId(personal.id);
  model = new PackageClaimModel("@scope/package", "https://registry.npmjs.org");
  return { writes, fetchMock };
}

test("only a manageable, unconfirmed personal claim needs the choice", () => {
  expect(managementChoicePending({ claim: provisional, destinations: [] })).toBe(true);
  expect(
    managementChoicePending({
      claim: { ...provisional, managementConfirmed: true },
      destinations: [],
    }),
  ).toBe(false);
  expect(
    managementChoicePending({
      claim: { kind: "organization", managementConfirmed: false, canManage: true },
      destinations: [],
    }),
  ).toBe(false);
  expect(managementChoicePending({ claim: null, destinations: [] })).toBe(false);
  expect(managementChoicePending(null)).toBe(false);
});

test("defaults to a shared destination and transfers only the claim, without switching organization", async () => {
  const { writes } = mockApi();
  await vi.waitFor(() => expect(model!.loading.value).toBe(false));
  expect(model!.pending.value).toBe(true);
  expect(model!.selectedOrganizationId.value).toBe(team.id);
  expect(await model!.choose()).toBe("moved");
  expect(writes).toEqual([
    {
      url: "/api/v1/npm-package-claims/@scope/package",
      body: { targetOrganizationId: team.id, registryUrl: "https://registry.npmjs.org" },
    },
  ]);
  expect(model!.movedTo.value).toEqual({ id: team.id, name: team.name });
  expect(activeOrganizationId.value).toBe(personal.id);
});

test("with no shared organization, the personal workspace is preselected and keeping confirms it", async () => {
  const { writes } = mockApi(provisional, []);
  await vi.waitFor(() => expect(model!.loading.value).toBe(false));
  expect(model!.selectedOrganizationId.value).toBe(personal.id);
  expect(await model!.choose()).toBe("kept");
  expect(writes.map((write) => write.body)).toEqual([
    { targetOrganizationId: personal.id, registryUrl: "https://registry.npmjs.org" },
  ]);
  expect(model!.kept.value).toBe(true);
  expect(model!.movedTo.value).toBeNull();
});

test("choosing enrolls no watch itself; watching stays the monitor's action", async () => {
  const { writes } = mockApi();
  await vi.waitFor(() => expect(model!.loading.value).toBe(false));
  model!.selectedOrganizationId.value = personal.id;
  expect(await model!.choose()).toBe("kept");
  expect(writes.map((write) => write.url)).toEqual(["/api/v1/npm-package-claims/@scope/package"]);
});

test("without a manageable personal claim there is nothing to choose or transfer", async () => {
  for (const claim of [
    null,
    { kind: "organization", managementConfirmed: true, canManage: true },
    { ...provisional, canManage: false },
  ] as const) {
    const { writes } = mockApi(claim);
    await vi.waitFor(() => expect(model!.loading.value).toBe(false));
    expect(model!.pending.value).toBe(false);
    expect(await model!.choose()).toBeNull();
    model!.selectedOrganizationId.value = personal.id;
    expect(await model!.choose()).toBeNull();
    expect(writes).toEqual([]);
    expect(model!.movedTo.value).toBeNull();
    model![Symbol.dispose]();
    model = null;
  }
});

test("an organization switch during confirmation discards its result", async () => {
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
  const request = model!.choose();
  setActiveOrganizationId(team.id);
  finish();
  expect(await request).toBeNull();
  expect(model!.kept.value).toBe(false);
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
    else expect(model!.movedTo.value).toEqual({ id: "team", name: "Release team" });
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
  expect(model!.movedTo.value).toBeNull();
});

test("an already confirmed personal claim is not confirmed again", async () => {
  const { writes } = mockApi({ ...provisional, managementConfirmed: true });
  await vi.waitFor(() => expect(model!.loading.value).toBe(false));
  expect(model!.pending.value).toBe(false);
  model!.selectedOrganizationId.value = personal.id;
  expect(await model!.choose()).toBe("kept");
  expect(writes).toEqual([]);
});

test("a name the claims route refuses has nothing to manage and reports no failure", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) =>
      input === "/api/v1/organizations"
        ? json({ organizations: [personal] })
        : Response.json({ error: "Enter a valid npm package and registry." }, { status: 400 }),
    ),
  );
  setActiveOrganizationId(personal.id);
  model = new PackageClaimModel("Not A Package");
  await vi.waitFor(() => expect(model!.loading.value).toBe(false));
  expect(model.error.value).toBeNull();
  expect(model.management.value).toEqual({ claim: null, destinations: [] });
  expect(model.pending.value).toBe(false);
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
