import { describe, expect, test } from "vitest";
import {
  parseGithubWebhookEvent,
  verifyGithubWebhookSignature,
} from "../server/lib/github-app/webhook.ts";

const WEBHOOK_SECRET = "webhook-secret-value-1234567890";

async function signBody(body) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  return "sha256=" + [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function buildRequestedPayload(overrides = {}) {
  return {
    action: "requested",
    environment: "pypi",
    deployment_callback_url:
      "https://api.github.com/repos/octo/example/actions/runs/77/deployment_protection_rule",
    deployment: { id: 9009 },
    installation: { id: 555 },
    repository: { id: 9001, full_name: "octo/example" },
    ...overrides,
  };
}

describe("verifyGithubWebhookSignature", () => {
  test("accepts a signature produced with the matching secret", async () => {
    const body = JSON.stringify({ hello: "world" });
    const signature = await signBody(body);
    expect(await verifyGithubWebhookSignature(WEBHOOK_SECRET, signature, body)).toBe(true);
  });

  test("rejects a missing or unexpectedly-formatted signature header", async () => {
    const body = JSON.stringify({ hello: "world" });
    expect(await verifyGithubWebhookSignature(WEBHOOK_SECRET, null, body)).toBe(false);
    expect(await verifyGithubWebhookSignature(WEBHOOK_SECRET, "", body)).toBe(false);
    expect(await verifyGithubWebhookSignature(WEBHOOK_SECRET, "sha1=abc", body)).toBe(false);
    expect(await verifyGithubWebhookSignature(WEBHOOK_SECRET, "sha256=zz", body)).toBe(false);
  });

  test("rejects a signature signed with a different secret", async () => {
    const body = JSON.stringify({ hello: "world" });
    const otherSecret = "another-secret-value-1234567890";
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(otherSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
    );
    const header =
      "sha256=" + [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(await verifyGithubWebhookSignature(WEBHOOK_SECRET, header, body)).toBe(false);
  });

  test("rejects a signature whose body has been tampered with", async () => {
    const body = JSON.stringify({ hello: "world" });
    const signature = await signBody(body);
    expect(await verifyGithubWebhookSignature(WEBHOOK_SECRET, signature, body + " ")).toBe(false);
  });
});

describe("parseGithubWebhookEvent (deployment_protection_rule)", () => {
  test("parses a well-formed requested payload", () => {
    const parsed = parseGithubWebhookEvent(
      "deployment_protection_rule",
      JSON.stringify(buildRequestedPayload()),
    );
    expect(parsed).toEqual({
      kind: "deployment_protection_rule",
      action: "requested",
      installationId: "555",
      repositoryId: 9001,
      repositoryFullName: "octo/example",
      environment: "pypi",
      runId: 77,
      deploymentId: 9009,
      deploymentCallbackUrl:
        "https://api.github.com/repos/octo/example/actions/runs/77/deployment_protection_rule",
    });
  });

  test("returns unsupported_action for actions other than requested", () => {
    const parsed = parseGithubWebhookEvent(
      "deployment_protection_rule",
      JSON.stringify(buildRequestedPayload({ action: "completed" })),
    );
    expect(parsed).toEqual({ error: "unsupported_action" });
  });

  test("rejects callback URLs that point outside api.github.com", () => {
    const parsed = parseGithubWebhookEvent(
      "deployment_protection_rule",
      JSON.stringify(
        buildRequestedPayload({
          deployment_callback_url:
            "https://evil.example.com/repos/octo/example/actions/runs/77/deployment_protection_rule",
        }),
      ),
    );
    expect(parsed).toEqual({ error: "invalid_callback_url" });
  });

  test("rejects callback URLs that do not follow the deployment-protection path", () => {
    const parsed = parseGithubWebhookEvent(
      "deployment_protection_rule",
      JSON.stringify(
        buildRequestedPayload({
          deployment_callback_url: "https://api.github.com/repos/octo/example/issues/1",
        }),
      ),
    );
    expect(parsed).toEqual({ error: "invalid_callback_url" });
  });

  test("requires installation, repository, environment, and callback url", () => {
    const cases = [
      { override: { installation: null }, error: "missing_installation" },
      { override: { repository: null }, error: "missing_repository" },
      { override: { environment: "" }, error: "missing_environment" },
      { override: { deployment_callback_url: "" }, error: "missing_callback_url" },
    ];
    for (const { override, error } of cases) {
      const parsed = parseGithubWebhookEvent(
        "deployment_protection_rule",
        JSON.stringify(buildRequestedPayload(override)),
      );
      expect(parsed).toEqual({ error });
    }
  });

  test("returns invalid_json for unparseable bodies", () => {
    const parsed = parseGithubWebhookEvent("deployment_protection_rule", "not json");
    expect(parsed).toEqual({ error: "invalid_json" });
  });
});

describe("parseGithubWebhookEvent (installation)", () => {
  test("parses suspend, unsuspend, and deleted actions", () => {
    for (const action of ["suspend", "unsuspend", "deleted"]) {
      const parsed = parseGithubWebhookEvent(
        "installation",
        JSON.stringify({ action, installation: { id: 555 } }),
      );
      expect(parsed).toEqual({
        kind: "installation",
        action,
        installationId: "555",
      });
    }
  });

  test("rejects unknown installation actions", () => {
    const parsed = parseGithubWebhookEvent(
      "installation",
      JSON.stringify({ action: "created", installation: { id: 555 } }),
    );
    expect(parsed).toEqual({ error: "unsupported_action" });
  });

  test("requires installation id", () => {
    const parsed = parseGithubWebhookEvent(
      "installation",
      JSON.stringify({ action: "suspend", installation: {} }),
    );
    expect(parsed).toEqual({ error: "missing_installation" });
  });
});

describe("parseGithubWebhookEvent (other events)", () => {
  test("returns unsupported_event for events outside our handler set", () => {
    const parsed = parseGithubWebhookEvent("push", JSON.stringify({ ref: "main" }));
    expect(parsed).toEqual({ error: "unsupported_event" });
  });
});
