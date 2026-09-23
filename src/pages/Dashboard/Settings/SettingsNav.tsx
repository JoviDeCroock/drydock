import { useEffect, useRef } from "preact/hooks";
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
  const navRef = useRef<HTMLElement>(null);

  // Below md the nav is a horizontal scroller, so a deep link to a later tab
  // can land with the active tab off-screen. Scroll only the nav, never the
  // page (scrollIntoView would also move the window), and do nothing when the
  // nav does not overflow (the md+ column).
  useEffect(() => {
    const nav = navRef.current;
    const current = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !current || nav.scrollWidth <= nav.clientWidth) return;
    const navBox = nav.getBoundingClientRect();
    const tabBox = current.getBoundingClientRect();
    if (tabBox.left < navBox.left) nav.scrollLeft -= navBox.left - tabBox.left;
    else if (tabBox.right > navBox.right) nav.scrollLeft += tabBox.right - navBox.right;
  }, [active]);

  return (
    <nav
      ref={navRef}
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
