import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  getOrganizationOwnerUserId: vi.fn(),
  getScan: vi.fn(),
  resolveNotificationEmails: vi.fn(),
  recordScanEvent: vi.fn().mockResolvedValue(undefined),
}));
const emailMock = vi.hoisted(() => ({
  sendNotificationEmail: vi.fn(),
}));

vi.mock("../server/db/index.ts", () => dbMock);
vi.mock("../server/lib/email.ts", () => emailMock);

const { notifyScanCompletion, notifyWorkflowGateReview } = await import("../server/lib/notify.ts");

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

beforeEach(() => {
  dbMock.getOrganizationOwnerUserId.mockResolvedValue("user_1");
  dbMock.resolveNotificationEmails.mockResolvedValue(["owner@example.com"]);
  dbMock.getScan.mockResolvedValue({
    scan: { packageName: "demo-package", stagedVersion: "1.2.0", risk: "high" },
  });
  emailMock.sendNotificationEmail.mockResolvedValue({ ok: true });
});

afterEach(() => {
  dbMock.getOrganizationOwnerUserId.mockReset();
  dbMock.resolveNotificationEmails.mockReset();
  dbMock.getScan.mockReset();
  dbMock.recordScanEvent.mockClear();
  emailMock.sendNotificationEmail.mockReset();
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
