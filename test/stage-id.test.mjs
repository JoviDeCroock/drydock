import { describe, expect, test } from "vitest";
import { isValidStageId, STAGE_ID_PATTERN } from "../server/lib/ecosystems/npm/stage-id";
import { parseScanInput } from "../server/lib/scan/input";

describe("isValidStageId", () => {
  test("accepts valid stage ids", () => {
    expect(isValidStageId("abc123")).toBe(true);
    expect(isValidStageId("my-package:1.0.0")).toBe(true);
    expect(isValidStageId("Scope.Package_v2.0.1-beta")).toBe(true);
    expect(isValidStageId("A".repeat(161))).toBe(true);
  });

  test("rejects too-short strings (< 6 chars)", () => {
    expect(isValidStageId("abc12")).toBe(false);
    expect(isValidStageId("a")).toBe(false);
    expect(isValidStageId("")).toBe(false);
  });

  test("rejects strings starting with non-alphanumeric", () => {
    expect(isValidStageId("-abcdef")).toBe(false);
    expect(isValidStageId(".abcdef")).toBe(false);
    expect(isValidStageId(":abcdef")).toBe(false);
    expect(isValidStageId("_abcdef")).toBe(false);
  });

  test("rejects strings with disallowed characters", () => {
    expect(isValidStageId("abc@def")).toBe(false);
    expect(isValidStageId("abc def")).toBe(false);
    expect(isValidStageId("abc/def")).toBe(false);
  });

  test("rejects non-string values", () => {
    expect(isValidStageId(null)).toBe(false);
    expect(isValidStageId(undefined)).toBe(false);
    expect(isValidStageId(123456)).toBe(false);
    expect(isValidStageId({})).toBe(false);
  });

  test("rejects strings exceeding 161 chars", () => {
    expect(isValidStageId("A" + "B".repeat(161))).toBe(false);
  });

  test("STAGE_ID_PATTERN is a valid regex source", () => {
    const re = new RegExp(`^${STAGE_ID_PATTERN}$`);
    expect(re.test("abc123")).toBe(true);
  });
});

describe("parseScanInput", () => {
  test("returns ok with valid stageId", () => {
    const result = parseScanInput({ stageId: "valid-stage-id-123" });
    // An unprefixed reference is npm's registry-issued staged-publish id.
    expect(result).toEqual({
      ok: true,
      input: { stageId: "valid-stage-id-123", ecosystem: "npm" },
    });
  });

  test("routes a prefixed reference to the ecosystem that spells it that way", () => {
    const stageId = "atpm:did:plc:twegdcgytckr5cxm57gyruxa:3lmabcdefghij";
    expect(parseScanInput({ stageId })).toEqual({
      ok: true,
      input: { stageId, ecosystem: "atpm" },
    });
  });

  test("accepts a valid did:web reference longer than npm's opaque id limit", () => {
    const host = `${Array.from({ length: 20 }, () => "aaaaaaa").join(".")}.com`;
    const stageId = `atpm:did:web:${host}:3lmabcdefghij:e852a96a-83f5-5c21-97c4-dce5b2f116ad`;
    expect(stageId.length).toBeGreaterThan(161);
    expect(parseScanInput({ stageId })).toEqual({
      ok: true,
      input: { stageId, ecosystem: "atpm" },
    });
  });

  test("rejects a prefixed reference the ecosystem cannot read", () => {
    for (const stageId of [
      "atpm:did:plc:twegdcgytckr5cxm57gyruxa:NOTATID",
      "atpm:did:example:abc:3lmabcdefghij",
      "atpm:3lmabcdefghij",
    ]) {
      expect(parseScanInput({ stageId }), stageId).toEqual({
        ok: false,
        error: "invalid atpm stageId",
        status: 400,
      });
    }
  });

  test("rejects missing stageId", () => {
    const result = parseScanInput({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid stageId");
      expect(result.status).toBe(400);
    }
  });

  test("rejects invalid stageId", () => {
    const result = parseScanInput({ stageId: "bad" });
    expect(result.ok).toBe(false);
  });

  test("rejects when maxFiles is provided", () => {
    const result = parseScanInput({ stageId: "valid-stage-id-123", maxFiles: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("scan limits are controlled by the server");
    }
  });

  test("rejects when maxBytesPerFile is provided", () => {
    const result = parseScanInput({ stageId: "valid-stage-id-123", maxBytesPerFile: 1024 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("scan limits are controlled by the server");
    }
  });
});
