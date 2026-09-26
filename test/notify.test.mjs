import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  getOrganizationOwnerUserId: vi.fn(),
  getOrganizationName: vi.fn(),
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

vi.mock("../server/db/events.ts", () => dbMock);
vi.mock("../server/db/organizations.ts", () => dbMock);
vi.mock("../server/db/scans.ts", () => dbMock);
vi.mock("../server/db/slack-connection.ts", () => dbMock);
vi.mock("../server/lib/notify/email.ts", () => emailMock);
vi.mock("../server/lib/platform/secret-box.ts", () => secretBoxMock);
vi.mock("../server/lib/notify/slack.ts", () => slackMock);

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

const {
  notifyNpmConnectionExpired,
  notifyPublicationCoverageGap,
  notifyPublicationDiscrepancy,
  notifyScanCompletion,
  notifyStagedReleaseApprovable,
  notifyStagedReleaseAwaitingApproval,
  notifyWorkflowGateReview,
} = await import("../server/lib/notify");

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

function awaitingApprovalInput(overrides = {}) {
  return {
    env: { BETTER_AUTH_URL: "https://drydock.test" },
    db: {},
    organizationId: "org_1",
    ownerUserId: "user_1",
    scanId: "scan_1",
    stageId: "stage-safe_123",
    packageName: "demo-package",
    version: "1.2.0",
    decidedAt: "2026-08-19T12:00:00.000Z",
    registryUrl: "https://registry.example.test/npm",
    ...overrides,
  };
}

beforeEach(() => {
  dbMock.getOrganizationOwnerUserId.mockResolvedValue("user_1");
  dbMock.getOrganizationName.mockResolvedValue("Acme Corp");
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
  dbMock.getOrganizationName.mockReset();
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
    expect(message.text).toContain("Organization: Acme Corp");
    expect(message.text).toContain("Release risk: high");
    expect(message.text).toContain("Repository: octo/example");
    expect(message.text).toContain("Environment: pypi");
    expect(message.text).toContain("https://drydock.test/dashboard/scans/scan_1?org=org_1");

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
  test("names the organization and deep-links the integrations tab to it", async () => {
    await notifyNpmConnectionExpired(npmConnectionExpiredInput());

    expect(emailMock.sendNotificationEmail).toHaveBeenCalledTimes(1);
    const [, message] = emailMock.sendNotificationEmail.mock.calls[0];
    expect(message.subject).toBe("Your npm token can no longer reach the staging registry");
    expect(message.text).toContain("with the saved token for Acme Corp");
    expect(message.text).toContain("Organization: Acme Corp");
    expect(message.text).toContain(
      "https://drydock.test/dashboard/settings?tab=integrations&org=org_1",
    );
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

  test("falls back to a generic phrasing without an Organization line when the org name is gone", async () => {
    dbMock.getOrganizationName.mockResolvedValue(null);

    await notifyNpmConnectionExpired(npmConnectionExpiredInput());

    const [, message] = emailMock.sendNotificationEmail.mock.calls[0];
    expect(message.text).toContain("with the saved token for your organization");
    expect(message.text).not.toContain("Organization:");
    // The link stays org-scoped even when the display name is unavailable.
    expect(message.text).toContain(
      "https://drydock.test/dashboard/settings?tab=integrations&org=org_1",
    );
  });
});

describe("notifyStagedReleaseAwaitingApproval", () => {
  test("pins the approval command to the captured registry", async () => {
    await notifyStagedReleaseAwaitingApproval(awaitingApprovalInput());

    const [, message] = emailMock.sendNotificationEmail.mock.calls[0];
    expect(message.text).toContain(
      "npm stage approve stage-safe_123 --registry 'https://registry.example.test/npm'",
    );
  });

  test("shell-quotes registry punctuation in the copy-paste command", async () => {
    await notifyStagedReleaseAwaitingApproval(
      awaitingApprovalInput({ registryUrl: "https://registry.example.test/team's" }),
    );

    const [, message] = emailMock.sendNotificationEmail.mock.calls[0];
    expect(message.text).toContain("--registry 'https://registry.example.test/team'\\''s'");
  });

  test("does not put legacy registry credentials into reminder email", async () => {
    await notifyStagedReleaseAwaitingApproval(
      awaitingApprovalInput({ registryUrl: "https://user:password@registry.example.test" }),
    );

    const [, message] = emailMock.sendNotificationEmail.mock.calls[0];
    expect(message.text).not.toContain("user:password");
    expect(message.text).not.toContain("npm stage approve");
  });
});

describe("notifyStagedReleaseApprovable", () => {
  function approvableInput(overrides = {}) {
    return {
      env: { BETTER_AUTH_URL: "https://drydock.test" },
      db: {},
      organizationId: "org_1",
      ownerUserId: "user_1",
      scanId: "scan_1",
      stageId: "stage-safe_123",
      packageName: "demo-package",
      version: "1.2.0",
      decision: null,
      registryUrl: "https://registry.example.test/npm",
      ...overrides,
    };
  }

  test("emails release identity, the risk grade, finding count, review link and the approve command", async () => {
    dbMock.getScan.mockResolvedValue({
      scan: { packageName: "demo-package", stagedVersion: "1.2.0", risk: "high" },
      riskSummary: {
        releaseRisk: "medium",
        artifactRisk: "high",
        releaseFindingCount: 2,
        contextFindingCount: 3,
      },
    });

    await notifyStagedReleaseApprovable(approvableInput());

    expect(emailMock.sendNotificationEmail).toHaveBeenCalledTimes(1);
    const [, message] = emailMock.sendNotificationEmail.mock.calls[0];
    expect(message.to).toBe("owner@example.com");
    expect(message.subject).toBe("demo-package@1.2.0 is ready to approve on npm");
    expect(message.text).toContain("npm has finished validating demo-package@1.2.0");
    expect(message.text).toContain("Release risk: medium.");
    expect(message.text).toContain("Findings: 5 findings (2 on the release diff).");
    expect(message.text).toContain("Drydock decision: none recorded yet.");
    expect(message.text).toContain("https://drydock.test/dashboard/scans/scan_1?org=org_1");
    expect(message.text).toContain(
      "npm stage approve stage-safe_123 --registry 'https://registry.example.test/npm'",
    );

    const [event] = dbMock.recordScanEvent.mock.calls.map(([, item]) => item);
    expect(event.type).toBe("scan.notification_sent");
    expect(event.metadata).toMatchObject({ channel: "email", trigger: "registry_approvable" });
  });

  test("names the Drydock decision when one was already recorded", async () => {
    await notifyStagedReleaseApprovable(approvableInput({ decision: "publish" }));
    const [, message] = emailMock.sendNotificationEmail.mock.calls[0];
    expect(message.text).toContain("Drydock decision: publish");
  });

  test("posts the same facts to Slack with the approve command in the status line", async () => {
    dbMock.getSlackConnectionSecret.mockResolvedValue(slackConnection());

    await notifyStagedReleaseApprovable(approvableInput());

    expect(slackMock.postSlackMessage).toHaveBeenCalledTimes(1);
    const [payload] = slackMock.renderSlackMessage.mock.calls.at(-1);
    expect(payload).toMatchObject({
      title: "Staged release ready to approve on npm",
      packageLabel: "demo-package@1.2.0",
      risk: "high",
      dashboardUrl: "https://drydock.test/dashboard/scans/scan_1?org=org_1",
    });
    expect(payload.statusLine).toContain("npm stage approve stage-safe_123 --registry");
    const [event] = slackEvents();
    expect(event.type).toBe("scan.notification_sent");
    expect(event.metadata).toMatchObject({ channel: "slack", trigger: "registry_approvable" });
  });

  test("drops the approve command rather than pasting an unsafe stage id or registry", async () => {
    await notifyStagedReleaseApprovable(
      approvableInput({ registryUrl: "https://user:password@registry.example.test" }),
    );
    const [, message] = emailMock.sendNotificationEmail.mock.calls[0];
    expect(message.text).not.toContain("user:password");
    expect(message.text).not.toContain("npm stage approve");
  });

  test("records a failure event instead of throwing when no recipients resolve", async () => {
    dbMock.resolveNotificationEmails.mockResolvedValue([]);

    await expect(notifyStagedReleaseApprovable(approvableInput())).resolves.toBeUndefined();

    expect(emailMock.sendNotificationEmail).not.toHaveBeenCalled();
    const [event] = dbMock.recordScanEvent.mock.calls.map(([, item]) => item);
    expect(event.type).toBe("scan.notification_failed");
    expect(event.metadata).toMatchObject({
      trigger: "registry_approvable",
      reason: "no_recipients",
    });
  });
});

describe("notifyScanCompletion", () => {
  test("resolves fallback recipients through the organization owner", async () => {
    await notifyScanCompletion(scanInput({ ownerUserId: "admin_1" }));

    expect(dbMock.getOrganizationOwnerUserId).toHaveBeenCalledWith({}, "org_1");
    expect(dbMock.resolveNotificationEmails).toHaveBeenCalledWith({}, "org_1", "user_1");
  });

  test("emails the resolved recipients on success with package and release risk", async () => {
    dbMock.resolveNotificationEmails.mockResolvedValue([
      "security@example.com",
      "lead@example.com",
    ]);

    await notifyScanCompletion(scanInput());

    expect(emailMock.sendNotificationEmail).toHaveBeenCalledTimes(2);
    const [, message] = emailMock.sendNotificationEmail.mock.calls[0];
    expect(message.subject).toContain("demo-package@1.2.0");
    expect(message.text).toContain("Organization: Acme Corp");
    expect(message.text).toContain("Release risk: high");
    expect(message.text).toContain("https://drydock.test/dashboard/scans/scan_1?org=org_1");

    expect(dbMock.recordScanEvent).toHaveBeenCalledTimes(2);
    for (const [, event] of dbMock.recordScanEvent.mock.calls) {
      expect(event.type).toBe("scan.notification_sent");
      expect(event.metadata).toMatchObject({ outcome: "complete", channel: "email" });
    }
  });

  test("surfaces approved release memory and the release-delta risk", async () => {
    dbMock.getSlackConnectionSecret.mockResolvedValue(slackConnection());
    dbMock.getScan.mockResolvedValue({
      scan: {
        packageName: "tape",
        stagedVersion: "5.9.0",
        risk: "high",
        summaryJson: {
          releaseConsistency: {
            status: "match",
            priorScanId: "scan_prior",
            priorVersion: "5.8.1",
            decidedAt: "2026-07-15T10:00:00.000Z",
            currentFindingCount: 2,
            priorFindingCount: 2,
            newFindingCount: 0,
            newFindings: [],
          },
        },
      },
      riskSummary: {
        artifactRisk: "high",
        releaseRisk: "low",
        contextRisk: "high",
        releaseFindingCount: 0,
        contextFindingCount: 2,
        unknownFindingCount: 0,
      },
    });

    await notifyScanCompletion(scanInput());

    const [, message] = emailMock.sendNotificationEmail.mock.calls[0];
    expect(message.text).toContain("Release risk: low");
    expect(message.text).toContain(
      "Release memory: Finding profile matches v5.8.1; the same deterministic findings were already reviewed and published.",
    );
    expect(message.text).not.toContain("Overall risk: high");

    expect(slackMock.renderSlackMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        risk: "low",
        releaseMemory:
          "Finding profile matches v5.8.1; the same deterministic findings were already reviewed and published.",
      }),
    );
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

describe("notifyPublicationDiscrepancy", () => {
  const input = {
    env: { BETTER_AUTH_URL: "https://drydock.test" },
    db: {},
    organizationId: "org_1",
    packageName: "@acme/package",
    version: "2.0.0",
    status: "published_without_approval",
  };

  test.each([
    [
      "published_without_approval",
      "Published with no approval in Acme Corp",
      "No approval in Acme Corp predates",
    ],
    [
      "published_despite_rejection",
      "Published despite a rejection in Acme Corp",
      "published after it was rejected in Acme Corp",
    ],
    [
      "artifact_mismatch",
      "Published bytes differ from what Acme Corp reviewed",
      "match no artifact reviewed in Acme Corp",
    ],
  ])(
    "delivers %s evidence to configured email recipients and Slack",
    async (status, title, evidence) => {
      dbMock.resolveNotificationEmails.mockResolvedValue([
        "lead@example.com",
        "security@example.com",
      ]);
      dbMock.getSlackConnectionSecret.mockResolvedValue(slackConnection());
      await notifyPublicationDiscrepancy({ ...input, status });
      expect(dbMock.resolveNotificationEmails).toHaveBeenCalledWith(input.db, "org_1", "user_1");
      expect(emailMock.sendNotificationEmail).toHaveBeenCalledTimes(2);
      for (const [, message] of emailMock.sendNotificationEmail.mock.calls) {
        expect(message.subject).toBe(`${title} — @acme/package@2.0.0`);
        expect(message.text).toContain(evidence);
        expect(message.text).toContain("Organization: Acme Corp");
        expect(message.text).toContain(
          "https://drydock.test/dashboard/packages/@acme/package?org=org_1",
        );
        // Scoped to this organization's records, never an accusation.
        expect(message.text).not.toMatch(/investigate who|unreviewed/i);
      }
      expect(slackMock.postSlackMessage).toHaveBeenCalledTimes(1);
      expect(slackMock.renderSlackMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          title,
          packageLabel: "@acme/package@2.0.0",
          statusLine: expect.stringContaining(evidence),
          dashboardUrl: "https://drydock.test/dashboard/packages/@acme/package?org=org_1",
        }),
      );
      expect(dbMock.recordScanEvent).toHaveBeenCalledTimes(3);
      for (const [, event] of dbMock.recordScanEvent.mock.calls) {
        expect(event).toMatchObject({
          organizationId: "org_1",
          actorUserId: "user_1",
          type: "scan.notification_sent",
          metadata: { trigger: "publication_discrepancy", status },
        });
        expect(JSON.stringify(event)).not.toContain(BOT_TOKEN);
      }
    },
  );

  test("still sends Slack when email has no recipients", async () => {
    dbMock.resolveNotificationEmails.mockResolvedValue([]);
    dbMock.getSlackConnectionSecret.mockResolvedValue(slackConnection());
    await notifyPublicationDiscrepancy(input);
    expect(emailMock.sendNotificationEmail).not.toHaveBeenCalled();
    expect(slackMock.postSlackMessage).toHaveBeenCalledTimes(1);
    expect(dbMock.recordScanEvent).toHaveBeenCalledWith(
      input.db,
      expect.objectContaining({
        type: "scan.notification_failed",
        metadata: expect.objectContaining({
          reason: "no_recipients",
          trigger: "publication_discrepancy",
        }),
      }),
    );
  });

  test("records email failure while delivering Slack independently", async () => {
    emailMock.sendNotificationEmail.mockResolvedValue({ ok: false, reason: "delivery_error" });
    dbMock.getSlackConnectionSecret.mockResolvedValue(slackConnection());
    await notifyPublicationDiscrepancy(input);
    expect(slackMock.postSlackMessage).toHaveBeenCalledTimes(1);
    expect(dbMock.recordScanEvent).toHaveBeenCalledWith(
      input.db,
      expect.objectContaining({
        type: "scan.notification_failed",
        metadata: expect.objectContaining({ channel: "email", reason: "delivery_error" }),
      }),
    );
  });

  test("does not deliver for an organization with no owner and keeps the alert pending", async () => {
    dbMock.getOrganizationOwnerUserId.mockResolvedValue(null);
    expect(await notifyPublicationDiscrepancy(input)).toBe("failed");
    expect(emailMock.sendNotificationEmail).not.toHaveBeenCalled();
    expect(slackMock.postSlackMessage).not.toHaveBeenCalled();
  });

  // The monitor marks an alert notified only on `delivered` or
  // `no_destination`; `failed` is what makes it re-send on the next check.
  test.each([
    [
      "one email lands while Slack fails",
      { ok: true },
      { ok: false, reason: "http_500" },
      "delivered",
    ],
    ["only Slack lands", { ok: false, reason: "smtp down" }, { ok: true }, "delivered"],
    [
      "every configured channel fails",
      { ok: false, reason: "smtp down" },
      { ok: false, statusClass: "5xx", reason: "http_500" },
      "failed",
    ],
    [
      "email has no transport and Slack fails",
      { ok: false, reason: "SEND_EMAIL binding is not configured", undeliverable: true },
      { ok: false, statusClass: "5xx", reason: "http_500" },
      "failed",
    ],
  ])("reports the real outcome when %s", async (_case, email, slack, outcome) => {
    dbMock.getSlackConnectionSecret.mockResolvedValue(slackConnection());
    emailMock.sendNotificationEmail.mockResolvedValue(email);
    slackMock.postSlackMessage.mockResolvedValue(slack);
    expect(await notifyPublicationDiscrepancy(input)).toBe(outcome);
  });

  test.each([
    [
      "published_without_approval",
      "review_pending",
      "Published with no approval in Acme Corp",
      "Drydock has an undecided review of these exact bytes: decide it, or investigate if nobody here published it.",
    ],
    [
      "published_without_approval",
      "reviewed_without_decision",
      "Published with no approval in Acme Corp",
      "undecided review of these exact bytes",
    ],
    [
      "published_despite_rejection",
      "rejected_after_publication",
      "Rejected in Acme Corp after it was published",
      "rejected in Acme Corp after they were published",
    ],
    [
      "artifact_mismatch",
      "review_history_limit",
      "Published bytes differ from what Acme Corp reviewed",
      "Only the latest 100 Drydock records of this version were compared.",
    ],
  ])("words %s with reason %s for what the records show", async (status, reason, title, detail) => {
    await notifyPublicationDiscrepancy({ ...input, status, reason });
    const [[, message]] = emailMock.sendNotificationEmail.mock.calls;
    expect(message.subject).toBe(`${title} — @acme/package@2.0.0`);
    expect(message.text).toContain(detail);
    expect(message.text).not.toMatch(/investigate who|unreviewed|compromis|attack/i);
    expect(dbMock.recordScanEvent).toHaveBeenCalledWith(
      input.db,
      expect.objectContaining({ metadata: expect.objectContaining({ status, reason }) }),
    );
  });

  test("a delivered alert stays delivered when recording the delivery fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dbMock.recordScanEvent.mockRejectedValue(new Error("D1 unavailable"));
    try {
      expect(await notifyPublicationDiscrepancy(input)).toBe("delivered");
      expect(emailMock.sendNotificationEmail).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "notification.audit_failed",
        expect.objectContaining({ organizationId: "org_1", type: "scan.notification_sent" }),
      );
    } finally {
      dbMock.recordScanEvent.mockReset();
      dbMock.recordScanEvent.mockResolvedValue(undefined);
      warn.mockRestore();
    }
  });

  test("reports no destination when nothing could ever receive it", async () => {
    dbMock.resolveNotificationEmails.mockResolvedValue([]);
    expect(await notifyPublicationDiscrepancy(input)).toBe("no_destination");
    dbMock.resolveNotificationEmails.mockResolvedValue(["owner@example.com"]);
    emailMock.sendNotificationEmail.mockResolvedValue({
      ok: false,
      reason: "SEND_EMAIL binding is not configured",
      undeliverable: true,
    });
    expect(await notifyPublicationDiscrepancy(input)).toBe("no_destination");
  });
});

describe("notifyPublicationCoverageGap", () => {
  const input = {
    env: { BETTER_AUTH_URL: "https://drydock.test" },
    db: {},
    organizationId: "org_1",
    packageName: "@acme/package",
  };

  test.each([
    ["2.0.0", "artifact_too_large", "@acme/package@2.0.0", "larger than Drydock hashes"],
    [null, "registry_metadata_too_large", "releases of @acme/package", "larger than Drydock reads"],
  ])(
    "says %s could not be verified (%s) without calling it a discrepancy",
    async (version, reason, subject, detail) => {
      dbMock.getSlackConnectionSecret.mockResolvedValue(slackConnection());
      expect(await notifyPublicationCoverageGap({ ...input, version, reason })).toBe("delivered");
      const [[, message]] = emailMock.sendNotificationEmail.mock.calls;
      expect(message.subject).toBe(
        `Drydock could not verify ${subject} against Acme Corp's reviews`,
      );
      expect(message.text).toContain(detail);
      expect(message.text).toContain("This is not a discrepancy");
      expect(message.text).not.toMatch(/published with no approval|despite|differ/i);
      expect(slackMock.renderSlackMessage).toHaveBeenCalledWith(
        expect.objectContaining({ statusLine: expect.stringContaining(detail) }),
      );
      expect(dbMock.recordScanEvent).toHaveBeenCalledWith(
        input.db,
        expect.objectContaining({
          metadata: expect.objectContaining({
            trigger: "publication_coverage_gap",
            version,
            reason,
          }),
        }),
      );
    },
  );
});
