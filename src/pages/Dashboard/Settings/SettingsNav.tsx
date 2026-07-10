import { cn } from "../../../components/cn";

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

export function SettingsNav({
  active,
  onSelect,
  tabs = SETTINGS_TABS,
}: {
  active: SettingsTab;
  onSelect: (tab: SettingsTab) => void;
  tabs?: ReadonlyArray<{ id: SettingsTab; label: string }>;
}) {
  return (
    <nav
      aria-label="Settings sections"
      class="flex md:flex-col gap-1 overflow-x-auto md:overflow-visible -mx-1 px-1 md:mx-0 md:px-0"
    >
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            aria-current={isActive ? "page" : undefined}
            onClick={() => onSelect(tab.id)}
            class={cn(
              "shrink-0 text-left rounded-md px-3 py-2 text-[13px] font-medium transition-colors duration-150 ease-out",
              isActive
                ? "bg-accent-soft text-accent"
                : "text-ink-muted hover:bg-surface-2 hover:text-ink",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
