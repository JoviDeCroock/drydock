const INITIAL_SCROLL_TARGET_SELECTOR = "[data-diff-scroll-target='true']";
const INITIAL_SCROLL_PADDING = 8;

export function shouldSeekInitialDiffTarget(status: string): boolean {
  return status === "added" || status === "removed" || status === "modified";
}

export function isDiffScrollTarget(
  status: string,
  tone: "added" | "removed" | "unchanged",
): boolean {
  return shouldSeekInitialDiffTarget(status) && tone !== "unchanged";
}

// Excluding findings prevents late annotations from resetting scroll position.
export function initialScrollResetKey(
  path: string,
  status: string,
  beforeSample: string,
  afterSample: string,
): string {
  return [
    path,
    status,
    beforeSample.length,
    afterSample.length,
    beforeSample.slice(0, 64),
    afterSample.slice(0, 64),
  ].join("\0");
}

export interface DiffScrollState {
  top: number;
  viewport: number;
  content: number;
}

export function resetDiffScroll(container: HTMLElement) {
  const target = container.querySelector<HTMLElement>(INITIAL_SCROLL_TARGET_SELECTOR);
  if (!target) {
    container.scrollTop = 0;
    return;
  }
  const targetTop =
    target.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop;
  container.scrollTop = Math.max(0, targetTop - INITIAL_SCROLL_PADDING);
}
