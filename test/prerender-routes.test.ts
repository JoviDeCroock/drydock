import { describe, expect, it } from "vitest";
import { isPrerenderedRoute } from "../src";

describe("isPrerenderedRoute", () => {
  it("matches generated public prerender pages with or without canonical trailing slashes", () => {
    expect(isPrerenderedRoute("/")).toBe(true);
    expect(isPrerenderedRoute("/login")).toBe(true);
    expect(isPrerenderedRoute("/login/")).toBe(true);
    expect(isPrerenderedRoute("/register")).toBe(true);
    expect(isPrerenderedRoute("/register/")).toBe(true);
  });

  it("does not hydrate pages that are not prerendered by the build", () => {
    expect(isPrerenderedRoute("/dashboard")).toBe(false);
    expect(isPrerenderedRoute("/docs")).toBe(false);
    expect(isPrerenderedRoute("/docs/intro")).toBe(false);
  });
});
