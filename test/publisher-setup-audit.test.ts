import { describe, expect, test } from "vitest";
import { AUDIT_VISIBLE_TYPES, describeAuditEvent } from "../server/lib/auth/audit-events";

describe("publisher setup audit evidence", () => {
  test("shows the repository and PR without exposing workflow or proposal credentials", () => {
    expect(AUDIT_VISIBLE_TYPES).toContain("github_app_setup.pr_created");
    const descriptor = describeAuditEvent("github_app_setup.pr_created", {
      repositoryFullName: "drydock/example",
      environment: "release",
      pullRequestNumber: 42,
      content: "private workflow contents",
      proposalToken: "private signed proposal",
      token: "private installation token",
    });
    expect(descriptor).toMatchObject({
      category: "integration",
      severity: "notice",
      detail: "drydock/example #42",
    });
    expect(JSON.stringify(descriptor)).not.toContain("private");
  });
});
