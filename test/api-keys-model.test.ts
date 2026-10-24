import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiKeysModel, type OrganizationApiKey } from "../src/models/api-keys";
import { jsonResponse, stubFetchRoutes } from "./helpers/fetch-stub";

const DAY_MS = 24 * 60 * 60 * 1000;

function apiKey(id: string, expiresInMs: number): OrganizationApiKey {
  return {
    id,
    name: id,
    prefix: `dd_${id}`,
    access: "read",
    createdAt: new Date(Date.now() - DAY_MS).toISOString(),
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    lastUsedAt: null,
    createdBy: { userId: "user-1", email: "owner@example.com", name: null },
  };
}

describe("ApiKeysModel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("counts only unexpired keys against the limit, like the server", async () => {
    stubFetchRoutes({
      "/api/v1/api-keys": () =>
        jsonResponse({
          keys: [apiKey("live", DAY_MS), apiKey("expired", -DAY_MS)],
          limit: 2,
          expiryDays: [30, 90, 365],
        }),
    });

    const model = new ApiKeysModel();
    await model.load(true);
    expect(model.atLimit.value).toBe(false);

    model.keys.value = [...model.keys.value, apiKey("second-live", DAY_MS)];
    expect(model.atLimit.value).toBe(true);
  });

  test("marks only the key being revoked", async () => {
    let finishDelete!: (response: Response) => void;
    stubFetchRoutes({
      "/api/v1/api-keys/one": () =>
        new Promise<Response>((resolve) => {
          finishDelete = resolve;
        }),
      "/api/v1/api-keys": () =>
        jsonResponse({
          keys: [apiKey("one", DAY_MS), apiKey("two", DAY_MS)],
          limit: 10,
          expiryDays: [30, 90, 365],
        }),
    });

    const model = new ApiKeysModel();
    await model.load(true);
    const revoke = model.revoke("one");
    expect(model.revokingKeyId.value).toBe("one");

    finishDelete(jsonResponse({ ok: true }));
    await revoke;
    expect(model.revokingKeyId.value).toBeNull();
    expect(model.keys.value.map((key) => key.id)).toEqual(["two"]);
  });

  test("a reload drops the revoking mark of a request it superseded", async () => {
    stubFetchRoutes({
      "/api/v1/api-keys/one": () => new Promise<Response>(() => {}),
      "/api/v1/api-keys": () =>
        jsonResponse({ keys: [apiKey("one", DAY_MS)], limit: 10, expiryDays: [30, 90, 365] }),
    });

    const model = new ApiKeysModel();
    await model.load(true);
    void model.revoke("one");
    await model.load(true);
    expect(model.revokingKeyId.value).toBeNull();
    expect(model.busy.value).toBe(false);
  });
});
