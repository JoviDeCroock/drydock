import { describe, expect, test } from "vitest";
import { personalOrganizationId, scanBelongsToOrganization } from "../server/lib/ownership.ts";

describe("ownership", () => {
  test("personal organization ids are stable per user", () => {
    expect(personalOrganizationId("user_123")).toBe("personal:user_123");
    expect(personalOrganizationId("user_123")).toBe(personalOrganizationId("user_123"));
    expect(personalOrganizationId("user_123")).not.toBe(personalOrganizationId("user_456"));
  });

  test("scan organization guard only allows matching organizations", () => {
    expect(scanBelongsToOrganization({ organizationId: "org_a" }, "org_a")).toBe(true);
    expect(scanBelongsToOrganization({ organizationId: "org_b" }, "org_a")).toBe(false);
    expect(scanBelongsToOrganization({ organizationId: null }, "org_a")).toBe(false);
  });
});
