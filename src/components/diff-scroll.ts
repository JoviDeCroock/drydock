/**
 * Scroll targeting and geometry for the diff viewport.
 *
 * Opening a file diff should land the reader on the first change rather than
 * at line 1, and the overview thumb needs viewport geometry without
 * rerendering the diff table on every scroll frame. Both are pure enough to
 * test on their own, so they live outside the components.
 */

import type { DiffFinding } from "./diff-annotations";

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

export function isAnnotationScrollTarget(
  seekFirstChange: boolean,
  annotation: Pick<DiffFinding, "kind">,
): boolean {
  // Findings are signals and may be the best first stop even when they pin to
  // unchanged context. Advisory comments are not: letting an earlier neutral
  // note win querySelector() would scroll past the release's first real change.
  return seekFirstChange && annotation.kind !== "comment";
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
