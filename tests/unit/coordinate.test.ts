import { describe, expect, it } from "vitest";
import {
  normalizedToScreenshot,
  screenshotToNormalized,
  screenshotToLogical,
  logicalToScreenshot,
  logicalToPhysical,
  physicalToLogical,
  convertPoint,
  rectCenter,
  pointInRect,
  distance,
  screenshotPointToPhysical,
  physicalPointToScreenshot,
} from "../../src/coordinate/index.js";
import type { Screenshot } from "../../src/core/types.js";

const shot: Screenshot = {
  format: "png",
  dataBase64: "",
  width: 1920,
  height: 1080,
  scale: 2,
  origin: { x: 100, y: 50 },
  orientation: "landscape",
  capturedAt: 0,
  targetId: "t",
};

describe("coordinate transforms (spec §29)", () => {
  it("normalized [0,1000] ↔ screenshot pixels", () => {
    // UI-Venus calibration case: button center at pixel (1300, 740) on 1920×1080
    const n = screenshotToNormalized({ x: 1300, y: 740 }, 1920, 1080);
    expect(n.x).toBeCloseTo(677.08, 1);
    expect(n.y).toBeCloseTo(685.18, 1);
    const back = normalizedToScreenshot(n, 1920, 1080);
    expect(back.x).toBeCloseTo(1300, 5);
    expect(back.y).toBeCloseTo(740, 5);
  });

  it("normalized corners map to image corners", () => {
    expect(normalizedToScreenshot({ x: 0, y: 0 }, 800, 600)).toEqual({ x: 0, y: 0 });
    expect(normalizedToScreenshot({ x: 1000, y: 1000 }, 800, 600)).toEqual({ x: 800, y: 600 });
  });

  it("normalized out-of-range is clamped", () => {
    const p = normalizedToScreenshot({ x: 1200, y: -50 }, 1000, 500);
    expect(p.x).toBe(1000);
    expect(p.y).toBe(0);
  });

  it("screenshot ↔ logical with Retina scale and window origin", () => {
    const pixel = { x: 200, y: 100 }; // inside the screenshot image
    const logical = screenshotToLogical(pixel, shot);
    expect(logical).toEqual({ x: 100 + 200 / 2, y: 50 + 100 / 2 });
    const back = logicalToScreenshot(logical, shot);
    expect(back.x).toBeCloseTo(200);
    expect(back.y).toBeCloseTo(100);
  });

  it("logical ↔ physical", () => {
    const physical = logicalToPhysical({ x: 100, y: 50 }, 2);
    expect(physical).toEqual({ x: 200, y: 100 });
    expect(physicalToLogical(physical, 2)).toEqual({ x: 100, y: 50 });
  });

  it("convertPoint across all spaces stays consistent", () => {
    const start = { x: 677, y: 685 }; // normalized
    const logical = convertPoint(start, "normalized", "logical", { screenshot: shot });
    // normalized (677,685) → screenshot px (1299.8, 739.8) → logical (100+649.9, 50+369.9)
    expect(logical.x).toBeCloseTo(749.9, 1);
    expect(logical.y).toBeCloseTo(419.9, 1);
    const physical = convertPoint(start, "normalized", "physical", { screenshot: shot });
    expect(physical.x).toBeCloseTo(logical.x * 2, 1);
    const norm2 = convertPoint(physical, "physical", "normalized", { screenshot: shot });
    expect(norm2.x).toBeCloseTo(start.x, 0);
    expect(norm2.y).toBeCloseTo(start.y, 0);
  });

  it("convertPoint rejects zero-scale", () => {
    expect(() => physicalToLogical({ x: 1, y: 1 }, 0)).toThrow();
  });

  it("screenshotPointToPhysical: the four real capture geometries", () => {
    // 1) identity — full screen, no downscale, origin 0
    const id: Screenshot = { ...shot, scale: 1, origin: { x: 0, y: 0 } };
    expect(screenshotPointToPhysical({ x: 100, y: 200 }, id)).toEqual({ x: 100, y: 200 });

    // 2) full screen downscaled 1920→1600 (scale 0.8333…) — the 151 case
    const ds: Screenshot = { ...shot, width: 1600, height: 900, scale: 1600 / 1920, origin: { x: 0, y: 0 } };
    const p2 = screenshotPointToPhysical({ x: 800, y: 450 }, ds);
    expect(p2.x).toBeCloseTo(960, 5); // 800 / (1600/1920)
    expect(p2.y).toBeCloseTo(540, 5);

    // 3) window region at (300,150) 400x300 physical, downscaled ×0.5
    const wr: Screenshot = { ...shot, width: 200, height: 150, scale: 0.5, origin: { x: 300, y: 150 } };
    const p3 = screenshotPointToPhysical({ x: 100, y: 75 }, wr);
    expect(p3).toEqual({ x: 300 + 200, y: 150 + 150 }); // center of the region

    // 4) negative multi-monitor origin
    const neg: Screenshot = { ...shot, scale: 1, origin: { x: -1920, y: 0 } };
    expect(screenshotPointToPhysical({ x: 96, y: 54 }, neg)).toEqual({ x: -1824, y: 54 });

    // roundtrip
    const back = physicalPointToScreenshot(p2, ds);
    expect(back.x).toBeCloseTo(800, 5);
    expect(back.y).toBeCloseTo(450, 5);
  });

  it("rect helpers", () => {
    const r = { x: 10, y: 20, width: 100, height: 50 };
    expect(rectCenter(r)).toEqual({ x: 60, y: 45 });
    expect(pointInRect({ x: 60, y: 45 }, r)).toBe(true);
    expect(pointInRect({ x: 5, y: 5 }, r)).toBe(false);
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
});
