import { describe, expect, test } from "vitest";
import {
  INVITABLE_ROLES,
  isInvitableRole,
  normalizeRole,
  ORGANIZATION_ROLES,
  roleCanManageIntegrations,
  roleCanManageMembers,
} from "../server/lib/roles.ts";

describe("normalizeRole", () => {
  test("passes through 'owner' unchanged", () => {
    expect(normalizeRole("owner")).toBe("owner");
  });

  test("passes through 'admin' unchanged", () => {
    expect(normalizeRole("admin")).toBe("admin");
  });

  test("normalizes 'member' to member", () => {
    expect(normalizeRole("member")).toBe("member");
  });

  test("normalizes unknown strings to member", () => {
    expect(normalizeRole("superuser")).toBe("member");
    expect(normalizeRole("")).toBe("member");
  });

  test("normalizes non-string values to member", () => {
    expect(normalizeRole(null)).toBe("member");
    expect(normalizeRole(undefined)).toBe("member");
    expect(normalizeRole(42)).toBe("member");
    expect(normalizeRole({})).toBe("member");
  });
});

describe("isInvitableRole", () => {
  test("accepts admin", () => {
    expect(isInvitableRole("admin")).toBe(true);
  });

  test("accepts member", () => {
    expect(isInvitableRole("member")).toBe(true);
  });

  test("rejects owner", () => {
    expect(isInvitableRole("owner")).toBe(false);
  });

  test("rejects unknown values", () => {
    expect(isInvitableRole("superuser")).toBe(false);
    expect(isInvitableRole(null)).toBe(false);
    expect(isInvitableRole(undefined)).toBe(false);
  });
});

describe("roleCanManageMembers", () => {
  test("owner can manage members", () => {
    expect(roleCanManageMembers("owner")).toBe(true);
  });

  test("admin can manage members", () => {
    expect(roleCanManageMembers("admin")).toBe(true);
  });

  test("member cannot manage members", () => {
    expect(roleCanManageMembers("member")).toBe(false);
  });

  test("null cannot manage members", () => {
    expect(roleCanManageMembers(null)).toBe(false);
  });
});

describe("roleCanManageIntegrations", () => {
  test("owner can manage integrations", () => {
    expect(roleCanManageIntegrations("owner")).toBe(true);
  });

  test("admin can manage integrations", () => {
    expect(roleCanManageIntegrations("admin")).toBe(true);
  });

  test("member cannot manage integrations", () => {
    expect(roleCanManageIntegrations("member")).toBe(false);
  });

  test("null cannot manage integrations", () => {
    expect(roleCanManageIntegrations(null)).toBe(false);
  });
});

describe("role constants", () => {
  test("ORGANIZATION_ROLES contains owner, admin, member", () => {
    expect(ORGANIZATION_ROLES).toEqual(["owner", "admin", "member"]);
  });

  test("INVITABLE_ROLES does not include owner", () => {
    expect(INVITABLE_ROLES).toEqual(["admin", "member"]);
    expect(INVITABLE_ROLES).not.toContain("owner");
  });
});
