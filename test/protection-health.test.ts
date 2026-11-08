import { describeAuditEvent } from "../server/lib/auth/audit-events";
import { describe, expect, test, vi } from "vitest";
import {
  readDependencyProtection,
  readEnvironmentProtection,
  readWorkflowContinuity,
} from "../server/lib/github-app/protection-health";
import type { SetupGithubClient } from "../server/lib/github-app/setup-api";
import { protectionHealthStatus } from "../server/lib/github-app/protection-health-types";

function client(responses: Record<string, unknown | Error>) {
  return {
    request: vi.fn(async (path: string) => {
      const value = responses[path];
      if (value === undefined || value instanceof Error)
        throw value ?? new Error("unread endpoint");
      return value;
    }),
  } as Pick<SetupGithubClient, "request">;
}
const rulesPath = "/rules/branches/main?per_page=100";
const rule = (app = 123) => ({
  type: "required_status_checks",
  ruleset_id: 7,
  parameters: {
    required_status_checks: [{ context: "Drydock dependency review", integration_id: app }],
  },
});

describe("live Environment protection", () => {
  test("checks the App identity and preserves an absent bypass field as unknown", async () => {
    const api = client({
      "/environments/production": {},
      "/environments/production/deployment_protection_rules": {
        total_count: 1,
        custom_deployment_protection_rules: [{ enabled: true, app: { id: 456 } }],
      },
    });
    expect(await readEnvironmentProtection(api, "production", "123")).toEqual({
      environmentExists: true,
      administratorsCanBypass: null,
      protectionEnabled: false,
    });
  });
  test("refuses incomplete protection listings", async () => {
    const api = client({
      "/environments/production": {},
      "/environments/production/deployment_protection_rules": {
        total_count: 2,
        custom_deployment_protection_rules: [{ enabled: true, app: { id: 123 } }],
      },
    });
    await expect(readEnvironmentProtection(api, "production", "123")).rejects.toThrow(
      "complete environment",
    );
  });
});
describe("default branch dependency protection", () => {
  test("recognizes a source-pinned active ruleset with no bypass actors", async () => {
    const api = client({
      [rulesPath]: [rule()],
      "/rulesets/7": { enforcement: "active", bypass_actors: [] },
    });
    expect((await readDependencyProtection(api, "main", "123", false)).status).toBe("passed");
  });
  test("does not trust the same check name from another App", async () => {
    const api = client({ [rulesPath]: [rule(456)], "/branches/main/protection": null });
    expect((await readDependencyProtection(api, "main", "123", true)).status).toBe("failed");
  });
  test.each([{ enforcement: "evaluate", bypass_actors: [] }, { enforcement: "active" }])(
    "missing or inactive bypass evidence stays unknown: %j",
    async (detail) => {
      const api = client({ [rulesPath]: [rule()], "/rulesets/7": detail });
      expect((await readDependencyProtection(api, "main", "123", false)).status).toBe("unknown");
    },
  );
  test("a known bypass remains a problem when both protection sources are readable", async () => {
    const api = client({
      [rulesPath]: [rule()],
      "/rulesets/7": {
        enforcement: "active",
        bypass_actors: [{ actor_type: "Team", actor_id: 1 }],
      },
      "/branches/main/protection": null,
    });
    expect((await readDependencyProtection(api, "main", "123", true)).status).toBe("failed");
  });
  test("can verify classic protection even if rulesets are unavailable", async () => {
    const api = client({
      [rulesPath]: new Error("upstream failed"),
      "/branches/main/protection": {
        enforce_admins: { enabled: true },
        required_status_checks: { checks: [{ context: "Drydock dependency review", app_id: 123 }] },
      },
    });
    expect((await readDependencyProtection(api, "main", "123", true)).status).toBe("passed");
  });
  test("missing classic permissions never turns an empty ruleset result into a verdict", async () => {
    const api = client({ [rulesPath]: [] });
    expect((await readDependencyProtection(api, "main", "123", false)).status).toBe("unknown");
    expect(api.request).toHaveBeenCalledTimes(1);
  });
  test("a capped rules listing stays unknown", async () => {
    const api = client({
      [rulesPath]: Array.from({ length: 100 }, () => ({ type: "deletion" })),
      "/branches/main/protection": null,
    });
    expect((await readDependencyProtection(api, "main", "123", true)).status).toBe("unknown");
  });
});
test("unknown coverage never reports protected", () => {
  expect(
    protectionHealthStatus([
      { id: "config", label: "Configuration", status: "unknown", detail: "unread" },
    ]),
  ).toBe("unknown");
  expect(protectionHealthStatus([])).toBe("unknown");
});

function workflowClient(changed = false): SetupGithubClient {
  const old = "a".repeat(40);
  const current = "b".repeat(40);
  const blob = "c".repeat(40);
  const other = "d".repeat(40);
  return {
    repository: { id: 42, fullName: "octo/release", defaultBranch: "main" },
    path: "/repos/octo/release",
    revokeToken: async () => {},
    request: async (path: string) => {
      if (path === "/actions/runs/123")
        return {
          id: 123,
          path: ".github/workflows/release.yml",
          head_sha: old,
          repository: { id: 42 },
        };
      if (path === "/git/ref/heads/main") return { object: { sha: current } };
      if (path.startsWith("/git/commits/"))
        return { sha: path.split("/").at(-1), tree: { sha: path.split("/").at(-1) } };
      if (path.startsWith("/git/trees/")) {
        const suffix = (path.endsWith(current) || path.endsWith(other)) && changed ? other : blob;
        return {
          truncated: false,
          tree: [
            { path: ".github", type: "tree", mode: "040000", sha: suffix },
            { path: "workflows", type: "tree", mode: "040000", sha: suffix },
            { path: "release.yml", type: "blob", mode: "100644", sha: suffix },
          ],
        };
      }
      if (path.startsWith("/contents/"))
        return {
          type: "file",
          path: ".github/workflows/release.yml",
          sha: (path.endsWith(current) || path.endsWith(other)) && changed ? other : blob,
          encoding: "base64",
          content: "eA==",
          size: 1,
        };
      throw new Error("unexpected read");
    },
  };
}
test("workflow continuity compares workflow blobs, allowing unrelated source commits", async () => {
  expect((await readWorkflowContinuity(workflowClient(), 123)).status).toBe("passed");
});
test("workflow changes need review, without asserting malicious behavior", async () => {
  expect((await readWorkflowContinuity(workflowClient(true), 123)).status).toBe("failed");
});
test("no completed gate leaves workflow continuity unknown", async () => {
  expect((await readWorkflowContinuity(workflowClient(), null)).status).toBe("unknown");
});

test("health transitions are visible without summarizing unexpected private metadata", () => {
  expect(
    describeAuditEvent("github_app.protection_health.changed", {
      repositoryFullName: "octo/release",
      environment: "production",
      status: "at_risk",
      accessToken: "secret",
    }),
  ).toMatchObject({ category: "security", detail: "octo/release / production: at risk" });
});
