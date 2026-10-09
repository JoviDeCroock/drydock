import { useEffect, useRef } from "preact/hooks";
import { cn } from "../../../components/cn";
import { SETTINGS_TABS, settingsTabHref, type SettingsTab } from "./settings-links";

// Tabs are plain links so each one can be opened in a new tab or copied. The
// router intercepts a plain click and the page reads ?tab= back from the URL,
// so switching stays client-side without a click handler here.
export function SettingsNav({
  active,
  tabs = SETTINGS_TABS,
}: {
  active: SettingsTab;
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
          <a
            key={tab.id}
            href={settingsTabHref(tab.id)}
            aria-current={isActive ? "page" : undefined}
            class={cn(
              "shrink-0 text-left no-underline rounded-md px-3 py-2 text-[13px] font-medium transition-colors duration-150 ease-out",
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
