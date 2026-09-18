import { afterEach, describe, expect, test, vi } from "vitest";
import { NotificationRecipientsModel } from "../src/models/notification-recipients";
import { jsonResponse, stubFetchRoutes } from "./helpers/fetch-stub";

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("NotificationRecipientsModel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("does not let a stale add reload overwrite a later organization load", async () => {
    const addOrgA = deferredResponse();
    stubFetchRoutes({
      "/org-a/notification-recipients": (_url, init) =>
        init?.method === "POST"
          ? addOrgA.promise
          : jsonResponse({ recipients: [{ id: "a", email: "a@example.com" }] }),
      "/org-b/notification-recipients": () =>
        jsonResponse({ recipients: [{ id: "b", email: "b@example.com" }] }),
      "": () => jsonResponse({ recipients: [] }),
    });

    const model = new NotificationRecipientsModel();
    await model.load("org-a");
    expect(model.recipients.value.map((recipient) => recipient.email)).toEqual(["a@example.com"]);

    model.draftEmail.value = "new-a@example.com";
    const add = model.add("org-a");
    await model.load("org-b");
    model.draftEmail.value = "new-b@example.com";

    addOrgA.resolve(jsonResponse({ recipient: { id: "new-a", email: "new-a@example.com" } }));
    await add;

    expect(model.recipients.value.map((recipient) => recipient.email)).toEqual(["b@example.com"]);
    expect(model.draftEmail.value).toBe("new-b@example.com");
  });
});
