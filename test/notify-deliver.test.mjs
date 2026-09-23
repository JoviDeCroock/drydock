import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  getOrganizationOwnerUserId: vi.fn(),
  resolveNotificationEmails: vi.fn(),
  getSlackConnectionSecret: vi.fn(),
  recordScanEvent: vi.fn().mockResolvedValue(undefined),
}));
const emailMock = vi.hoisted(() => ({ sendNotificationEmail: vi.fn() }));
const secretBoxMock = vi.hoisted(() => ({ decryptSlackBotToken: vi.fn() }));
const slackMock = vi.hoisted(() => ({
  postSlackMessage: vi.fn(),
  renderSlackMessage: vi.fn(() => ({ text: "rendered", blocks: [] })),
}));

vi.mock("../server/db/events.ts", () => dbMock);
vi.mock("../server/db/organizations.ts", () => dbMock);
vi.mock("../server/db/slack-connection.ts", () => dbMock);
vi.mock("../server/lib/notify/email.ts", () => emailMock);
vi.mock("../server/lib/platform/secret-box.ts", () => secretBoxMock);
vi.mock("../server/lib/notify/slack.ts", () => slackMock);

const { deliverOrganizationNotification } = await import("../server/lib/notify/deliver");

const env = { BETTER_AUTH_URL: "https://drydock.test" };
const db = {};

function notification(overrides = {}) {
  return {
    organizationId: "org_1",
    ownerUserId: "sweep_actor",
    scanId: "scan_1",
    eventPrefix: "scan",
    eventMetadata: { trigger: "unit" },
    email: { subject: "Subject", lines: ["Hi there,", null, "Body", "", "— Drydock"] },
    slack: { title: "Title", packageLabel: "demo@1.0.0", source: "npm staged publish" },
    ...overrides,
  };
}

function events() {
  return dbMock.recordScanEvent.mock.calls.map(([, event]) => event);
}

function slackConnection(overrides = {}) {
  return {
    channelId: "C123",
    channelName: "releases",
    enabled: true,
    botTokenCiphertext: "v1:ciphertext",
    botTokenNonce: "nonce",
    ...overrides,
  };
}

beforeEach(() => {
  dbMock.getOrganizationOwnerUserId.mockResolvedValue("owner_1");
  dbMock.resolveNotificationEmails.mockResolvedValue(["a@example.com", "b@example.com"]);
  dbMock.getSlackConnectionSecret.mockResolvedValue(null);
  emailMock.sendNotificationEmail.mockResolvedValue({ ok: true });
  secretBoxMock.decryptSlackBotToken.mockResolvedValue("xoxb-secret");
  slackMock.postSlackMessage.mockResolvedValue({ ok: true, status: 200, statusClass: "2xx" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("deliverOrganizationNotification", () => {
  test("resolves the organization owner as both recipient fallback and event actor", async () => {
    await deliverOrganizationNotification(env, db, notification());

    expect(dbMock.resolveNotificationEmails).toHaveBeenCalledWith(db, "org_1", "owner_1");
    expect(emailMock.sendNotificationEmail).toHaveBeenCalledTimes(2);
    const [, message] = emailMock.sendNotificationEmail.mock.calls[0];
    expect(message).toEqual({
      to: "a@example.com",
      subject: "Subject",
      text: "Hi there,\nBody\n\n— Drydock",
    });
    expect(events()).toEqual([
      {
        organizationId: "org_1",
        actorUserId: "owner_1",
        scanId: "scan_1",
        type: "scan.notification_sent",
        metadata: { trigger: "unit", channel: "email", recipient: "a@example.com" },
      },
      {
        organizationId: "org_1",
        actorUserId: "owner_1",
        scanId: "scan_1",
        type: "scan.notification_sent",
        metadata: { trigger: "unit", channel: "email", recipient: "b@example.com" },
      },
    ]);
  });

  test("falls back to the caller's owner id when the organization has no owner row", async () => {
    dbMock.getOrganizationOwnerUserId.mockResolvedValue(null);

    await deliverOrganizationNotification(env, db, notification());

    expect(dbMock.resolveNotificationEmails).toHaveBeenCalledWith(db, "org_1", "sweep_actor");
    // `every` on an empty array is true, so assert the events exist before
    // asserting what they attribute to.
    const actors = events().map((event) => event.actorUserId);
    expect(actors.length).toBeGreaterThan(0);
    expect(actors).toEqual(actors.map(() => "sweep_actor"));
  });

  test("omits scanId from events for notifications without a scan", async () => {
    await deliverOrganizationNotification(
      env,
      db,
      notification({ scanId: undefined, eventPrefix: "npm_connection", slack: null }),
    );

    const [event] = events();
    expect(event).not.toHaveProperty("scanId");
    expect(event.type).toBe("npm_connection.notification_sent");
  });

  test("records a single no_recipients failure and still posts to Slack", async () => {
    dbMock.resolveNotificationEmails.mockResolvedValue([]);
    dbMock.getSlackConnectionSecret.mockResolvedValue(slackConnection());

    await expect(deliverOrganizationNotification(env, db, notification())).resolves.toBeUndefined();

    expect(emailMock.sendNotificationEmail).not.toHaveBeenCalled();
    expect(slackMock.postSlackMessage).toHaveBeenCalledTimes(1);
    expect(events()).toEqual([
      {
        organizationId: "org_1",
        actorUserId: "owner_1",
        scanId: "scan_1",
        type: "scan.notification_failed",
        metadata: { trigger: "unit", channel: "email", reason: "no_recipients" },
      },
      {
        organizationId: "org_1",
        actorUserId: "owner_1",
        scanId: "scan_1",
        type: "scan.notification_sent",
        metadata: {
          trigger: "unit",
          channel: "slack",
          channelName: "releases",
          statusClass: "2xx",
        },
      },
    ]);
  });

  test("records an email failure per recipient with its reason and does not throw", async () => {
    dbMock.resolveNotificationEmails.mockResolvedValue(["a@example.com"]);
    emailMock.sendNotificationEmail.mockResolvedValue({ ok: false, reason: "binding_missing" });

    await expect(deliverOrganizationNotification(env, db, notification())).resolves.toBeUndefined();

    expect(events()).toEqual([
      {
        organizationId: "org_1",
        actorUserId: "owner_1",
        scanId: "scan_1",
        type: "scan.notification_failed",
        metadata: {
          trigger: "unit",
          channel: "email",
          recipient: "a@example.com",
          reason: "binding_missing",
        },
      },
    ]);
  });

  test("delivers slack-only notifications without resolving recipients", async () => {
    dbMock.getSlackConnectionSecret.mockResolvedValue(slackConnection());

    await deliverOrganizationNotification(env, db, notification({ email: null }));

    expect(dbMock.resolveNotificationEmails).not.toHaveBeenCalled();
    expect(emailMock.sendNotificationEmail).not.toHaveBeenCalled();
    const [token, channelId] = slackMock.postSlackMessage.mock.calls[0];
    expect(token).toBe("xoxb-secret");
    expect(channelId).toBe("C123");
    expect(events()).toHaveLength(1);
    expect(JSON.stringify(events())).not.toContain("xoxb-secret");
  });

  test("records delivery_error and never posts when the Slack token cannot be decrypted", async () => {
    dbMock.getSlackConnectionSecret.mockResolvedValue(slackConnection());
    secretBoxMock.decryptSlackBotToken.mockRejectedValue(new Error("bad key"));

    await deliverOrganizationNotification(env, db, notification({ email: null }));

    expect(slackMock.postSlackMessage).not.toHaveBeenCalled();
    const [event] = events();
    expect(event.type).toBe("scan.notification_failed");
    expect(event.metadata).toEqual({
      trigger: "unit",
      channel: "slack",
      channelName: "releases",
      statusClass: "other",
      reason: "delivery_error",
    });
  });

  test("skips Slack silently when the connection is disabled or has no channel", async () => {
    dbMock.getSlackConnectionSecret.mockResolvedValue(slackConnection({ enabled: false }));
    await deliverOrganizationNotification(env, db, notification({ email: null }));

    dbMock.getSlackConnectionSecret.mockResolvedValue(slackConnection({ channelId: null }));
    await deliverOrganizationNotification(env, db, notification({ email: null }));

    expect(secretBoxMock.decryptSlackBotToken).not.toHaveBeenCalled();
    expect(events()).toHaveLength(0);
  });
});
