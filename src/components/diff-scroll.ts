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

// Pinned annotations carry their finding id; the banner above the pane does
// too, but it sits outside the scroll container this queries.
const PINNED_FINDING_SELECTOR = "[data-finding-id]";
// Rows of source kept above a finding's line when the pane seeks to it.
const FINDING_CONTEXT_PX = 64;

interface InitialScrollGeometry {
  viewport: number;
  // Offsets within the scroll content, or null when the pane has none.
  firstChangeTop: number | null;
  finding: { sourceTop: number; bottom: number } | null;
}

/**
 * Where a newly opened file's pane starts. The first change leads, unless the
 * first pinned finding would then sit outside the pane: a finding only visible
 * as a rail tick has not been shown.
 */
export function initialDiffScrollTop({
  viewport,
  firstChangeTop,
  finding,
}: InitialScrollGeometry): number {
  const changeTop =
    firstChangeTop === null ? 0 : Math.max(0, firstChangeTop - INITIAL_SCROLL_PADDING);
  if (!finding) return changeTop;
  if (finding.sourceTop >= changeTop && finding.bottom <= changeTop + viewport) return changeTop;
  return Math.max(0, finding.sourceTop - FINDING_CONTEXT_PX);
}

export function resetDiffScroll(container: HTMLElement) {
  const origin = container.getBoundingClientRect().top - container.scrollTop;
  const offset = (element: Element) => element.getBoundingClientRect().top - origin;
  const change = container.querySelector<HTMLElement>(INITIAL_SCROLL_TARGET_SELECTOR);
  const annotation = container.querySelector<HTMLElement>(PINNED_FINDING_SELECTOR);
  // The annotation row sits directly beneath the line it is about; seek to
  // that line so the reader sees the code before the explanation.
  const findingRow = annotation?.closest("tr") ?? null;
  const sourceRow = findingRow?.previousElementSibling ?? findingRow;
  container.scrollTop = initialDiffScrollTop({
    viewport: container.clientHeight,
    firstChangeTop: change ? offset(change) : null,
    finding:
      findingRow && sourceRow
        ? {
            sourceTop: offset(sourceRow),
            bottom: offset(findingRow) + findingRow.getBoundingClientRect().height,
          }
        : null,
  });
}
