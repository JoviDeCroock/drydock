import { describe, expect, test, vi } from "vitest";
import { h, type VNode } from "preact";
import prerender from "preact-iso/prerender";
import { SettingsNav } from "../src/pages/Dashboard/Settings/SettingsNav";
import {
  SETTINGS_SECTION,
  scrollToSettingsSection,
  settingsTabHref,
} from "../src/pages/Dashboard/Settings/settings-links";

describe("settings tab addresses", () => {
  test("general is the bare settings path and other tabs name themselves", () => {
    expect(settingsTabHref("general")).toBe("/dashboard/settings");
    expect(settingsTabHref("audit")).toBe("/dashboard/settings?tab=audit");
  });

  test("points at an integrations section by its stable id", () => {
    expect(settingsTabHref("integrations", SETTINGS_SECTION.githubApp)).toBe(
      "/dashboard/settings?tab=integrations#github-app",
    );
    expect(settingsTabHref("integrations", SETTINGS_SECTION.npmAccess)).toBe(
      "/dashboard/settings?tab=integrations#npm-access",
    );
  });

  test("renders every tab as a link that can be opened or copied", async () => {
    const { html } = await prerender(h(SettingsNav, { active: "integrations" }) as VNode);

    expect(html).not.toContain("<button");
    expect(html).toContain('href="/dashboard/settings"');
    expect(html).toContain('href="/dashboard/settings?tab=members"');
    expect(html).toMatch(/href="\/dashboard\/settings\?tab=integrations"[^>]*aria-current="page"/);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });
});

describe("settings section scroll", () => {
  test("scrolls the section the hash names", () => {
    const scrollIntoView = vi.fn();
    const getElementById = vi.fn((id: string) => (id === "github-app" ? { scrollIntoView } : null));

    expect(scrollToSettingsSection("#github-app", { getElementById })).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });

  test("ignores empty, malformed, and absent targets", () => {
    const getElementById = vi.fn(() => null);

    expect(scrollToSettingsSection("", { getElementById })).toBe(false);
    expect(scrollToSettingsSection("#", { getElementById })).toBe(false);
    expect(scrollToSettingsSection("#%E0%A4%A", { getElementById })).toBe(false);
    expect(scrollToSettingsSection("#npm-access", { getElementById })).toBe(false);
  });
});
