import { describe, expect, test } from "vitest";
import { shouldOfferShare } from "../src/pages/Dashboard/ScanDetail/ScanDetailChrome";

describe("shouldOfferShare", () => {
  test("an approved release offers the link", () => {
    expect(shouldOfferShare("publish", false)).toBe(true);
  });

  test("an undecided release does not", () => {
    expect(shouldOfferShare(null, false)).toBe(false);
    expect(shouldOfferShare(undefined, false)).toBe(false);
  });

  test("a blocked release does not", () => {
    expect(shouldOfferShare("no_publish", false)).toBe(false);
  });

  test("an existing link keeps the action reachable so it can be revoked", () => {
    // Approved → shared → decision flipped to blocked. Hiding the action here
    // would leave a live public report with no way to reach revoke.
    expect(shouldOfferShare("no_publish", true)).toBe(true);
    expect(shouldOfferShare(null, true)).toBe(true);
  });
});
