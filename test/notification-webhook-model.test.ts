import { afterEach, describe, expect, test, vi } from "vitest";
import { NotificationWebhookModel } from "../src/models/notification-webhook";

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

const connection = { hostname: "hooks.example.com", enabled: true, createdAt: 1 };

describe("NotificationWebhookModel", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("saves write-only credentials and clears the form after success", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ connection: null }))
      .mockResolvedValueOnce(json({ connection }));
    vi.stubGlobal("fetch", fetch);
    const model = new NotificationWebhookModel();
    await model.load("org-a");
    model.draftUrl.value = "https://hooks.example.com/private-path";
    model.draftSecret.value = "a".repeat(32);
    expect(await model.save()).toBe(true);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
      url: "https://hooks.example.com/private-path",
      secret: "a".repeat(32),
    });
    expect(model.connection.value).toEqual(connection);
    expect(model.draftUrl.value).toBe("");
    expect(model.draftSecret.value).toBe("");
  });

  test("an old save cannot overwrite a new organization or clear its draft", async () => {
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ connection: null }))
        .mockReturnValueOnce(pending)
        .mockResolvedValueOnce(json({ connection: null })),
    );
    const model = new NotificationWebhookModel();
    await model.load("org-a");
    model.draftUrl.value = "https://hooks.example.com";
    model.draftSecret.value = "a".repeat(32);
    const save = model.save();
    await model.load("org-b");
    expect(model.draftSecret.value).toBe("");
    model.draftUrl.value = "https://other.example.com";
    resolve(json({ connection }));
    expect(await save).toBe(false);
    expect(model.connection.value).toBe(null);
    expect(model.draftUrl.value).toBe("https://other.example.com");
    expect(model.notice.value).toBe(null);
  });

  test("a test failure remains distinct from successful delivery", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ connection }))
        .mockResolvedValueOnce(json({ ok: false, reason: "http_status" })),
    );
    const model = new NotificationWebhookModel();
    await model.load("org-a");
    await model.test();
    expect(model.error.value).toContain("could not be delivered");
    expect(model.notice.value).toBe(null);
    expect(model.busy.value).toBe(false);
  });
});
