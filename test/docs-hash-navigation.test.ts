import { describe, expect, test, vi } from "vitest";
import { docsHashTargetId, scrollToDocsHash } from "../src/pages/Docs/hash-navigation";

describe("docs hash navigation", () => {
  test("decodes a valid docs target", () => {
    expect(docsHashTargetId("#renovate-diff-links")).toBe("renovate-diff-links");
    expect(docsHashTargetId("#dependency%2Dupdates")).toBe("dependency-updates");
  });

  test("ignores empty and malformed hashes", () => {
    expect(docsHashTargetId("")).toBeNull();
    expect(docsHashTargetId("#")).toBeNull();
    expect(docsHashTargetId("#%E0%A4%A")).toBeNull();
  });

  test("scrolls the matching docs title into view", () => {
    const scrollIntoView = vi.fn();
    const getElementById = vi.fn((id: string) =>
      id === "dependabot-diff-links" ? { scrollIntoView } : null,
    );

    expect(scrollToDocsHash("#dependabot-diff-links", { getElementById })).toBe(true);
    expect(getElementById).toHaveBeenCalledWith("dependabot-diff-links");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });

  test("does nothing when the target is absent", () => {
    const getElementById = vi.fn(() => null);

    expect(scrollToDocsHash("#missing", { getElementById })).toBe(false);
  });
});
