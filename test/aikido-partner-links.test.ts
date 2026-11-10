import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { aikidoUrl } from "../src/components/AikidoPartner";

const sponsorLinkSources = [
  "../src/components/AikidoPartner.tsx",
  "../src/features/aikido-partner/InstallProtection.tsx",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));

describe("Aikido sponsor links", () => {
  test("carry only static source and placement attribution", () => {
    const url = new URL(aikidoUrl("diff-install-protection"));
    expect(url.origin).toBe("https://www.aikido.dev");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      utm_source: "drydock",
      utm_medium: "referral",
      utm_content: "diff-install-protection",
    });
  });

  test("let the origin-only referrer through", () => {
    for (const source of sponsorLinkSources) {
      expect(source).toContain('rel="noopener"');
      expect(source).not.toMatch(/rel="[^"]*noreferrer/);
    }
  });
});
