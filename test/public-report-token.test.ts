import { describe, expect, test } from "vitest";
import { hasShareToken } from "../src/pages/PublicReport/index";

// `hasShareToken` gates both halves of the tokenless `/reports` state: the page
// skips the `/public/reports/<token>` lookup entirely when it is false, and
// renders the "no public index" explainer instead of the revoked/invalid error.
// There is no DOM test environment in this repo, so the render itself is not
// asserted here — the branch is a single call to this predicate.
describe("hasShareToken", () => {
  test("a share token routes to the report lookup", () => {
    expect(hasShareToken("k4YQ2s1a")).toBe(true);
  });

  test("a bare /reports visit has no token to look up", () => {
    // `route.params.token` is undefined on the tokenless route; the page
    // coalesces it to "" before this call, so both spellings must be false.
    expect(hasShareToken(undefined)).toBe(false);
    expect(hasShareToken(null)).toBe(false);
    expect(hasShareToken("")).toBe(false);
  });

  test("a whitespace-only token is not a link either", () => {
    // A pasted link that wrapped can leave "%20" behind, which decodes to a
    // space. Firing the lookup for it would answer with the revoked message.
    expect(hasShareToken(" ")).toBe(false);
    expect(hasShareToken("\n\t")).toBe(false);
  });
});
