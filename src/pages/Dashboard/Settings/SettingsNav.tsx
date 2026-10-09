import { cn } from "../../../components/cn";
import { SETTINGS_TABS, settingsTabHref, type SettingsTab } from "./settings-links";

// Tabs are plain links so each one can be opened in a new tab or copied. The
// router intercepts a plain click and the page reads ?tab= back from the URL,
// so switching stays client-side without a click handler here.
//
// Below md the tabs wrap rather than scroll sideways: a scroller hid the later
// tabs with nothing on screen saying they existed, and a deep link could land
// with the current tab out of view.
export function SettingsNav({
  active,
  tabs = SETTINGS_TABS,
}: {
  active: SettingsTab;
  tabs?: ReadonlyArray<{ id: SettingsTab; label: string }>;
}) {
  return (
    <nav aria-label="Settings sections" class="flex flex-wrap md:flex-col md:flex-nowrap gap-1">
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <a
            key={tab.id}
            href={settingsTabHref(tab.id)}
            aria-current={isActive ? "page" : undefined}
            class={cn(
              "text-left no-underline rounded-md px-3 py-2 text-[13px] font-medium transition-colors duration-150 ease-out",
              isActive
                ? "bg-accent-soft text-accent"
                : "text-ink-muted hover:bg-surface-2 hover:text-ink",
            )}
          >
            {tab.label}
          </a>
        );
      })}
    </nav>
  );
}
