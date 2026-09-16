import { describe, expect, test } from "vitest";
import { personalOrganizationId } from "../server/lib/auth/ownership";

describe("ownership", () => {
  test("personal organization ids are stable per user", () => {
    expect(personalOrganizationId("user_123")).toBe("personal:user_123");
    expect(personalOrganizationId("user_123")).toBe(personalOrganizationId("user_123"));
    expect(personalOrganizationId("user_123")).not.toBe(personalOrganizationId("user_456"));
  });
});
