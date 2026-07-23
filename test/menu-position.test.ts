import { describe, expect, test } from "vitest";
import { menuPanelPosition } from "../src/components/menu-position";

describe("menuPanelPosition", () => {
  test("places the panel below the trigger when it fits", () => {
    expect(
      menuPanelPosition(
        { top: 40, right: 180, bottom: 68, left: 152, width: 28, height: 28 },
        { width: 120, height: 80 },
        { width: 320, height: 640 },
        "end",
      ),
    ).toEqual({ top: 72, left: 60 });
  });

  test("flips the panel above a trigger near the viewport bottom", () => {
    expect(
      menuPanelPosition(
        { top: 580, right: 300, bottom: 608, left: 272, width: 28, height: 28 },
        { width: 200, height: 72 },
        { width: 320, height: 640 },
        "end",
      ),
    ).toEqual({ top: 504, left: 100 });
  });

  test("clamps start-aligned panels inside the viewport", () => {
    expect(
      menuPanelPosition(
        { top: 40, right: 26, bottom: 68, left: -2, width: 28, height: 28 },
        { width: 200, height: 80 },
        { width: 320, height: 640 },
        "start",
      ),
    ).toEqual({ top: 72, left: 8 });
  });
});
