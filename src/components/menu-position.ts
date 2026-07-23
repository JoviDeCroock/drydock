export interface MenuRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export interface MenuPanelPosition {
  top: number;
  left: number;
}

const VIEWPORT_PADDING = 8;
const TRIGGER_GAP = 4;

export function menuPanelPosition(
  trigger: MenuRect,
  panel: Pick<MenuRect, "width" | "height">,
  viewport: { width: number; height: number },
  align: "start" | "end",
): MenuPanelPosition {
  const preferredLeft = align === "end" ? trigger.right - panel.width : trigger.left;
  const maxLeft = Math.max(VIEWPORT_PADDING, viewport.width - panel.width - VIEWPORT_PADDING);
  const left = Math.min(Math.max(preferredLeft, VIEWPORT_PADDING), maxLeft);

  const below = trigger.bottom + TRIGGER_GAP;
  const above = trigger.top - panel.height - TRIGGER_GAP;
  const maxTop = Math.max(VIEWPORT_PADDING, viewport.height - panel.height - VIEWPORT_PADDING);
  const top =
    below + panel.height <= viewport.height - VIEWPORT_PADDING
      ? below
      : above >= VIEWPORT_PADDING
        ? above
        : Math.min(Math.max(below, VIEWPORT_PADDING), maxTop);

  return { top, left };
}
