import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  getScan: vi.fn(),
  getUserContact: vi.fn(),
  recordScanEvent: vi.fn().mockResolvedValue(undefined),
}));
const emailMock = vi.hoisted(() => ({
  sendNotificationEmail: vi.fn(),
}));

vi.mock("../server/db/index.ts", () => dbMock);
vi.mock("../server/lib/email.ts", () => emailMock);

const { notifyWorkflowGateReview } = await import("../server/lib/notify.ts");

function baseInput(overrides = {}) {
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

describe("notifyWorkflowGateReview", () => {
  beforeEach(() => {
    dbMock.getUserContact.mockResolvedValue({
      id: "user_1",
      email: "owner@example.com",
      name: "Olga",
    });
    emailMock.sendNotificationEmail.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    dbMock.getUserContact.mockReset();
    dbMock.recordScanEvent.mockClear();
    emailMock.sendNotificationEmail.mockReset();
  });

  test("emails the owner with release identity, risk, repo, environment and a dashboard link", async () => {
    await notifyWorkflowGateReview(baseInput());

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
      metadata: { gateId: "gate_1", channel: "email", releaseRisk: "high" },
    });
  });

  test("never leaks token, header, or callback material into the email", async () => {
    await notifyWorkflowGateReview(baseInput());

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

    await expect(notifyWorkflowGateReview(baseInput())).resolves.toBeUndefined();

    const [, event] = dbMock.recordScanEvent.mock.calls[0];
    expect(event.type).toBe("github_workflow_gate.notification_failed");
    expect(event.metadata).toMatchObject({
      gateId: "gate_1",
      channel: "email",
      reason: "smtp down",
    });
  });

  test("skips delivery and records a failure when the owner has no email on record", async () => {
    dbMock.getUserContact.mockResolvedValue({ id: "user_1", email: null, name: "Olga" });

    await notifyWorkflowGateReview(baseInput());

    expect(emailMock.sendNotificationEmail).not.toHaveBeenCalled();
    const [, event] = dbMock.recordScanEvent.mock.calls[0];
    expect(event.type).toBe("github_workflow_gate.notification_failed");
    expect(event.metadata).toMatchObject({ gateId: "gate_1", reason: "no_contact_email" });
  });
});
