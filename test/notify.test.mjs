import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  getOrganizationOwnerUserId: vi.fn(),
  getScan: vi.fn(),
  resolveNotificationEmails: vi.fn(),
  getSlackConnectionSecret: vi.fn(),
  recordScanEvent: vi.fn().mockResolvedValue(undefined),
}));
const emailMock = vi.hoisted(() => ({
  sendNotificationEmail: vi.fn(),
}));
const secretBoxMock = vi.hoisted(() => ({
  decryptSlackBotToken: vi.fn(),
}));
const slackMock = vi.hoisted(() => ({
  postSlackMessage: vi.fn(),
  renderSlackMessage: vi.fn(() => ({ text: "rendered", blocks: [] })),
}));

vi.mock("../server/db/index.ts", () => dbMock);
vi.mock("../server/lib/email.ts", () => emailMock);
vi.mock("../server/lib/secret-box.ts", () => secretBoxMock);
vi.mock("../server/lib/slack.ts", () => slackMock);

const BOT_TOKEN = "xoxb-0000000000-SUPERSECRETTOKEN";

function slackConnection(overrides = {}) {
  return {
    id: "conn_1",
    organizationId: "org_1",
    teamId: "T1",
    teamName: "Acme",
    channelId: "C123",
    channelName: "releases",
    enabled: true,
    botTokenCiphertext: "v1:ciphertext",
    botTokenNonce: "nonce",
    ...overrides,
  };
}

function slackEvents() {
  return dbMock.recordScanEvent.mock.calls
    .map(([, event]) => event)
    .filter((event) => event.metadata.channel === "slack");
}

const { notifyNpmConnectionExpired, notifyScanCompletion, notifyWorkflowGateReview } =
  await import("../server/lib/notify.ts");

function gateInput(overrides = {}) {
  return {
    env: { BETTER_AUTH_URL: "https://drydock.test" },
    db: {},
    organizationId: "org_1",
    ownerUserId: "user_1",
    gateId: "gate_1",
    repositoryFullName: "octo/example",
    environment: "pypi",
    scanId: "scan_1",
    packageName: "demo-package",
    version: "1.2.0",
    releaseRisk: "high",
    ...overrides,
  };
}

function scanInput(overrides = {}) {
  return {
    env: { BETTER_AUTH_URL: "https://drydock.test" },
    db: {},
    scanId: "scan_1",
    organizationId: "org_1",
    ownerUserId: "user_1",
    outcome: "complete",
    ...overrides,
  };
}

function npmConnectionExpiredInput(overrides = {}) {
  return {
    env: { BETTER_AUTH_URL: "https://drydock.test" },
    db: {},
    organizationId: "org_1",
    ownerUserId: "user_1",
    registryUrl: "https://registry.npmjs.org",
    ...overrides,
  };
}

beforeEach(() => {
  dbMock.getOrganizationOwnerUserId.mockResolvedValue("user_1");
  dbMock.resolveNotificationEmails.mockResolvedValue(["owner@example.com"]);
  dbMock.getSlackConnectionSecret.mockResolvedValue(null);
  dbMock.getScan.mockResolvedValue({
    scan: { packageName: "demo-package", stagedVersion: "1.2.0", risk: "high" },
  });
  emailMock.sendNotificationEmail.mockResolvedValue({ ok: true });
  secretBoxMock.decryptSlackBotToken.mockResolvedValue(BOT_TOKEN);
  slackMock.postSlackMessage.mockResolvedValue({ ok: true, status: 200, statusClass: "2xx" });
});

afterEach(() => {
  dbMock.getOrganizationOwnerUserId.mockReset();
  dbMock.resolveNotificationEmails.mockReset();
  dbMock.getSlackConnectionSecret.mockReset();
  dbMock.getScan.mockReset();
  dbMock.recordScanEvent.mockClear();
  emailMock.sendNotificationEmail.mockReset();
  secretBoxMock.decryptSlackBotToken.mockReset();
  slackMock.postSlackMessage.mockReset();
  slackMock.renderSlackMessage.mockClear();
});

describe("notifyWorkflowGateReview", () => {
  test("emails the resolved recipient with release identity, risk, repo, environment and a link", async () => {
    await notifyWorkflowGateReview(gateInput());

    expect(emailMock.sendNotificationEmail).toHaveBeenCalledTimes(1);
    const [, message] = emailMock.sendNotificationEmail.mock.calls[0];
    expect(message.to).toBe("owner@example.com");
    expect(message.subject).toContain("demo-package@1.2.0");
    expect(message.text).toContain("demo-package@1.2.0");
    expect(message.text).toContain("Release risk: high");
    expect(message.text).toContain("Repository: octo/example");
    expect(message.text).toContain("Environment: pypi");
    expect(message.text).toContain("https://drydock.test/dashboard/scans/scan_1");

    expect(dbMock.recordScanEvent).toHaveBeenCalledTimes(1);
    const [, event] = dbMock.recordScanEvent.mock.calls[0];
    expect(event).toMatchObject({
      organizationId: "org_1",
      actorUserId: "user_1",
      scanId: "scan_1",
      type: "github_workflow_gate.notification_sent",
      metadata: {
        gateId: "gate_1",
        channel: "email",
        releaseRisk: "high",
        recipient: "owner@example.com",
      },
    });
  });

  test("fans out to every configured recipient and records one event each", async () => {
    dbMock.resolveNotificationEmails.mockResolvedValue([
      "security@example.com",
      "lead@example.com",
    ]);

    await notifyWorkflowGateReview(gateInput());

    expect(emailMock.sendNotificationEmail).toHaveBeenCalledTimes(2);
    const recipients = emailMock.sendNotificationEmail.mock.calls.map(([, m]) => m.to).sort();
    expect(recipients).toEqual(["lead@example.com", "security@example.com"]);

    expect(dbMock.recordScanEvent).toHaveBeenCalledTimes(2);
    const eventRecipients = dbMock.recordScanEvent.mock.calls.map(([, e]) => e.metadata.recipient);
    expect(eventRecipients.sort()).toEqual(["lead@example.com", "security@example.com"]);
    for (const [, event] of dbMock.recordScanEvent.mock.calls) {
      expect(event.type).toBe("github_workflow_gate.notification_sent");
    }
  });

  test("flags a monorepo bundle so the owner knows every package needs approval", async () => {
    await notifyWorkflowGateReview(gateInput({ packageCount: 3 }));

    const [, message] = emailMock.sendNotificationEmail.mock.calls[0];
    expect(message.text).toContain(
      "demo-package@1.2.0 (+2 more in this release; each must be approved)",
    );
  });

  test("never leaks token, header, or callback material into the email", async () => {
    await notifyWorkflowGateReview(gateInput());

    const [, message] = emailMock.sendNotificationEmail.mock.calls[0];
    const payload = `${message.subject}\n${message.text}`;
    for (const secret of [
      "ghs_",
      "Authorization",
      "Bearer",
      "deployment_protection_rule",
      "api.github.com",
      "deployment_callback_url",
    ]) {
      expect(payload).not.toContain(secret);
    }
  });

  test("records a delivery failure without throwing", async () => {
    emailMock.sendNotificationEmail.mockResolvedValue({ ok: false, reason: "smtp down" });

    await expect(notifyWorkflowGateReview(gateInput())).resolves.toBeUndefined();

    const [, event] = dbMock.recordScanEvent.mock.calls[0];
    expect(event.type).toBe("github_workflow_gate.notification_failed");
    expect(event.metadata).toMatchObject({
      gateId: "gate_1",
      channel: "email",
      reason: "smtp down",
      recipient: "owner@example.com",
    });
  });

  test("skips delivery and records a failure when no recipients resolve", async () => {
    dbMock.resolveNotificationEmails.mockResolvedValue([]);

    await notifyWorkflowGateReview(gateInput());

    expect(emailMock.sendNotificationEmail).not.toHaveBeenCalled();
    expect(dbMock.recordScanEvent).toHaveBeenCalledTimes(1);
    const [, event] = dbMock.recordScanEvent.mock.calls[0];
    expect(event.type).toBe("github_workflow_gate.notification_failed");
    expect(event.metadata).toMatchObject({ gateId: "gate_1", reason: "no_recipients" });
  });
});

describe("notifyNpmConnectionExpired", () => {
  test("emails the integrations tab link for replacing the npm token", async () => {
    await notifyNpmConnectionExpired(npmConnectionExpiredInput());

    expect(emailMock.sendNotificationEmail).toHaveBeenCalledTimes(1);
    const [, message] = emailMock.sendNotificationEmail.mock.calls[0];
    expect(message.subject).toBe("Your npm token can no longer reach the staging registry");
    expect(message.text).toContain("https://drydock.test/dashboard/settings?tab=integrations");
    expect(message.text).toContain("Registry: https://registry.npmjs.org");

    expect(dbMock.recordScanEvent).toHaveBeenCalledTimes(1);
    const [, event] = dbMock.recordScanEvent.mock.calls[0];
    expect(event).toMatchObject({
      organizationId: "org_1",
      actorUserId: "user_1",
      type: "npm_connection.notification_sent",
      metadata: {
        channel: "email",
        trigger: "token_expired",
        recipient: "owner@example.com",
      },
    });
  });
});

describe("notifyScanCompletion", () => {
  test("resolves fallback recipients through the organization owner", async () => {
    await notifyScanCompletion(scanInput({ ownerUserId: "admin_1" }));

    expect(dbMock.getOrganizationOwnerUserId).toHaveBeenCalledWith({}, "org_1");
    expect(dbMock.resolveNotificationEmails).toHaveBeenCalledWith({}, "org_1", "user_1");
  });

  test("emails the resolved recipients on success with package and risk", async () => {
    dbMock.resolveNotificationEmails.mockResolvedValue([
      "security@example.com",
      "lead@example.com",
    ]);

    await notifyScanCompletion(scanInput());

    expect(emailMock.sendNotificationEmail).toHaveBeenCalledTimes(2);
    const [, message] = emailMock.sendNotificationEmail.mock.calls[0];
    expect(message.subject).toContain("demo-package@1.2.0");
    expect(message.text).toContain("Overall risk: high");
    expect(message.text).toContain("https://drydock.test/dashboard/scans/scan_1");

    expect(dbMock.recordScanEvent).toHaveBeenCalledTimes(2);
    for (const [, event] of dbMock.recordScanEvent.mock.calls) {
      expect(event.type).toBe("scan.notification_sent");
      expect(event.metadata).toMatchObject({ outcome: "complete", channel: "email" });
    }
  });

  test("reports the failure reason on a failed scan", async () => {
    await notifyScanCompletion(
      scanInput({ outcome: "failed", error: { code: "boom", message: "tarball unavailable" } }),
    );

    const [, message] = emailMock.sendNotificationEmail.mock.calls[0];
    expect(message.subject).toContain("Staged release scan failed");
    expect(message.text).toContain("Reason: tarball unavailable");
    const [, event] = dbMock.recordScanEvent.mock.calls[0];
    expect(event.type).toBe("scan.notification_sent");
    expect(event.metadata.outcome).toBe("failed");
  });

  test("records a failure event when no recipients resolve", async () => {
    dbMock.resolveNotificationEmails.mockResolvedValue([]);

    await notifyScanCompletion(scanInput());

    expect(emailMock.sendNotificationEmail).not.toHaveBeenCalled();
    const [, event] = dbMock.recordScanEvent.mock.calls[0];
    expect(event.type).toBe("scan.notification_failed");
    expect(event.metadata).toMatchObject({ outcome: "complete", reason: "no_recipients" });
  });
});

describe("Slack connection delivery", () => {
  test("posts a workflow-gate review to the connected channel without leaking the token", async () => {
    dbMock.getSlackConnectionSecret.mockResolvedValue(slackConnection());

    await notifyWorkflowGateReview(gateInput());

    expect(secretBoxMock.decryptSlackBotToken).toHaveBeenCalledTimes(1);
    expect(slackMock.postSlackMessage).toHaveBeenCalledTimes(1);
    const [token, channelId] = slackMock.postSlackMessage.mock.calls[0];
    expect(token).toBe(BOT_TOKEN);
    expect(channelId).toBe("C123");

    const events = slackEvents();
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.type).toBe("github_workflow_gate.notification_sent");
    expect(event.metadata).toMatchObject({
      channel: "slack",
      channelName: "releases",
      gateId: "gate_1",
      releaseRisk: "high",
      statusClass: "2xx",
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(BOT_TOKEN);
    expect(serialized).not.toContain("ciphertext");
  });

  test("flags a monorepo bundle in the Slack payload so the headline isn't read as the whole release", async () => {
    dbMock.getSlackConnectionSecret.mockResolvedValue(slackConnection());

    await notifyWorkflowGateReview(gateInput({ packageCount: 2 }));

    expect(slackMock.renderSlackMessage).toHaveBeenCalledTimes(1);
    const [payload] = slackMock.renderSlackMessage.mock.calls[0];
    expect(payload.packageLabel).toBe(
      "demo-package@1.2.0 (+1 more in this release; each must be approved)",
    );
  });

  test("keeps the Slack package label bare for a single-package gate", async () => {
    dbMock.getSlackConnectionSecret.mockResolvedValue(slackConnection());

    await notifyWorkflowGateReview(gateInput({ packageCount: 1 }));

    const [payload] = slackMock.renderSlackMessage.mock.calls[0];
    expect(payload.packageLabel).toBe("demo-package@1.2.0");
  });

  test("records a delivery failure with its reason but no token", async () => {
    dbMock.getSlackConnectionSecret.mockResolvedValue(slackConnection());
    slackMock.postSlackMessage.mockResolvedValue({
      ok: false,
      status: 200,
      statusClass: "2xx",
      reason: "channel_not_found",
    });

    await expect(notifyWorkflowGateReview(gateInput())).resolves.toBeUndefined();

    const [event] = slackEvents();
    expect(event.type).toBe("github_workflow_gate.notification_failed");
    expect(event.metadata).toMatchObject({
      channel: "slack",
      channelName: "releases",
      reason: "channel_not_found",
    });
    expect(JSON.stringify(event)).not.toContain(BOT_TOKEN);
  });

  test("surfaces rate-limit metadata when Slack returns 429", async () => {
    dbMock.getSlackConnectionSecret.mockResolvedValue(slackConnection());
    slackMock.postSlackMessage.mockResolvedValue({
      ok: false,
      status: 429,
      statusClass: "4xx",
      rateLimited: true,
      retryAfterSeconds: 30,
      reason: "rate_limited",
    });

    await notifyWorkflowGateReview(gateInput());

    const [event] = slackEvents();
    expect(event.type).toBe("github_workflow_gate.notification_failed");
    expect(event.metadata).toMatchObject({ rateLimited: true, retryAfterSeconds: 30 });
  });

  test("records delivery_error and never posts when decryption fails", async () => {
    dbMock.getSlackConnectionSecret.mockResolvedValue(slackConnection());
    secretBoxMock.decryptSlackBotToken.mockRejectedValue(new Error("bad key material"));

    await expect(notifyWorkflowGateReview(gateInput())).resolves.toBeUndefined();

    expect(slackMock.postSlackMessage).not.toHaveBeenCalled();
    const [event] = slackEvents();
    expect(event.type).toBe("github_workflow_gate.notification_failed");
    expect(event.metadata).toMatchObject({ channel: "slack", reason: "delivery_error" });
    expect(JSON.stringify(event)).not.toContain("bad key material");
  });

  test("silently skips when the connection is disabled or has no channel", async () => {
    dbMock.getSlackConnectionSecret.mockResolvedValue(slackConnection({ enabled: false }));
    await notifyWorkflowGateReview(gateInput());
    expect(slackMock.postSlackMessage).not.toHaveBeenCalled();
    expect(slackEvents()).toHaveLength(0);

    dbMock.recordScanEvent.mockClear();
    dbMock.getSlackConnectionSecret.mockResolvedValue(slackConnection({ channelId: null }));
    await notifyWorkflowGateReview(gateInput());
    expect(slackMock.postSlackMessage).not.toHaveBeenCalled();
    expect(slackEvents()).toHaveLength(0);
  });

  test("fans a completed scan out to Slack with the scan outcome", async () => {
    dbMock.getSlackConnectionSecret.mockResolvedValue(slackConnection());

    await notifyScanCompletion(scanInput());

    const [event] = slackEvents();
    expect(event.type).toBe("scan.notification_sent");
    expect(event.metadata).toMatchObject({ channel: "slack", outcome: "complete" });
  });

  test("delivers to Slack even when no email recipients resolve", async () => {
    dbMock.resolveNotificationEmails.mockResolvedValue([]);
    dbMock.getSlackConnectionSecret.mockResolvedValue(slackConnection());

    await notifyScanCompletion(scanInput());

    expect(emailMock.sendNotificationEmail).not.toHaveBeenCalled();
    expect(slackMock.postSlackMessage).toHaveBeenCalledTimes(1);

    const emailEvents = dbMock.recordScanEvent.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.metadata.channel === "email");
    expect(emailEvents).toHaveLength(1);
    expect(emailEvents[0].metadata.reason).toBe("no_recipients");

    const [slackEvent] = slackEvents();
    expect(slackEvent.type).toBe("scan.notification_sent");
  });
});
