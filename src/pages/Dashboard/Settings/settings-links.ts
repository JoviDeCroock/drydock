export type SettingsTab = "general" | "members" | "notifications" | "integrations" | "audit";

export const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTab; label: string }> = [
  { id: "general", label: "General" },
  { id: "members", label: "Members" },
  { id: "notifications", label: "Notifications" },
  { id: "integrations", label: "Integrations" },
  { id: "audit", label: "Audit log" },
];

export function isSettingsTab(value: unknown): value is SettingsTab {
  return SETTINGS_TABS.some((tab) => tab.id === value);
}

/**
 * Sections other pages link to directly. The ids are part of the settings
 * page's address (`?tab=integrations#github-app`), so renaming one breaks
 * links already sent in emails and callbacks.
 */
export const SETTINGS_SECTION = {
  npmAccess: "npm-access",
  githubApp: "github-app",
} as const;

type SettingsSectionId = (typeof SETTINGS_SECTION)[keyof typeof SETTINGS_SECTION];

/** Address of one settings tab, optionally pointing at a section on it. */
export function settingsTabHref(tab: SettingsTab, section?: SettingsSectionId): string {
  const search = tab === "general" ? "" : `?tab=${tab}`;
  return `/dashboard/settings${search}${section ? `#${section}` : ""}`;
}

type HashTargetRoot = {
  getElementById(id: string): { scrollIntoView(options?: ScrollIntoViewOptions): void } | null;
};

/**
 * Scroll to the section a settings URL's hash names. The browser's own anchor
 * jump happens before the tab's content exists (it renders only after the
 * workspace loads), so the page calls this once that content is on screen.
 */
export function scrollToSettingsSection(hash: string, root: HashTargetRoot): boolean {
  if (!hash.startsWith("#") || hash.length === 1) return false;
  let id: string;
  try {
    id = decodeURIComponent(hash.slice(1));
  } catch {
    return false;
  }
  const target = root.getElementById(id);
  if (!target) return false;
  target.scrollIntoView({ block: "start" });
  return true;
}
