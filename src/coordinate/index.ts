/**
 * Cross-platform coordinate system (spec §29).
 *
 * Vision models speak normalized [0,1000] coordinates. Every platform has
 * its own logical space with DPI/Retina/fractional scaling on top. All
 * transforms are explicit, pure and unit-tested; adapters never guess.
 *
 *   Vision normalized [0,1000]
 *        ↕ normalizedToScreenshot / screenshotToNormalized
 *   Screenshot pixel space (image coordinates)
 *        ↕ screenshotToLogical (adds image origin, divides scale)
 *   Platform logical space (points / DIP)
 *        ↕ logicalToPhysical
 *   Physical device pixels
 */
import type { Point, Rect, Screenshot } from "../core/types.js";
import { ComputerUseError } from "../core/errors.js";

export type CoordinateSpace = "normalized" | "screenshot" | "logical" | "physical";

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** [0,1000] normalized (vision output) → screenshot pixel space. */
export function normalizedToScreenshot(
  p: Point,
  imageWidth: number,
  imageHeight: number,
): Point {
  return {
    x: clamp((p.x / 1000) * imageWidth, 0, imageWidth),
    y: clamp((p.y / 1000) * imageHeight, 0, imageHeight),
  };
}

/** Screenshot pixel space → [0,1000] normalized. */
export function screenshotToNormalized(
  p: Point,
  imageWidth: number,
  imageHeight: number,
): Point {
  if (imageWidth <= 0 || imageHeight <= 0) {
    throw new ComputerUseError("invalid_request", "Screenshot has zero size");
  }
  return {
    x: clamp((p.x / imageWidth) * 1000, 0, 1000),
    y: clamp((p.y / imageHeight) * 1000, 0, 1000),
  };
}

/**
 * Screenshot pixel space → platform logical space.
 * Accounts for the image origin (window/ROI captures) and pixel scale.
 */
export function screenshotToLogical(p: Point, shot: Screenshot): Point {
  const scale = shot.scale > 0 ? shot.scale : 1;
  return {
    x: shot.origin.x + p.x / scale,
    y: shot.origin.y + p.y / scale,
  };
}

/** Platform logical space → screenshot pixel space. */
export function logicalToScreenshot(p: Point, shot: Screenshot): Point {
  const scale = shot.scale > 0 ? shot.scale : 1;
  return {
    x: (p.x - shot.origin.x) * scale,
    y: (p.y - shot.origin.y) * scale,
  };
}

export function logicalToPhysical(p: Point, scale: number): Point {
  return { x: p.x * scale, y: p.y * scale };
}

export function physicalToLogical(p: Point, scale: number): Point {
  if (scale <= 0) throw new ComputerUseError("invalid_request", "Invalid scale");
  return { x: p.x / scale, y: p.y / scale };
}

/** Universal converter between any two spaces. */
export function convertPoint(
  p: Point,
  from: CoordinateSpace,
  to: CoordinateSpace,
  ctx: { screenshot?: Screenshot; scale?: number },
): Point {
  if (from === to) return p;
  const scale = ctx.scale ?? (ctx.screenshot ? (ctx.screenshot.scale > 0 ? ctx.screenshot.scale : 1) : 1);
  const shot = ctx.screenshot;

  // Express in logical space first.
  let logical: Point;
  switch (from) {
    case "normalized":
      if (!shot) throw new ComputerUseError("invalid_request", "normalized→logical needs the screenshot");
      logical = screenshotToLogical(normalizedToScreenshot(p, shot.width, shot.height), shot);
      break;
    case "screenshot":
      if (!shot) throw new ComputerUseError("invalid_request", "screenshot→logical needs the screenshot");
      logical = screenshotToLogical(p, shot);
      break;
    case "logical":
      logical = p;
      break;
    case "physical":
      logical = physicalToLogical(p, scale);
      break;
  }

  switch (to) {
    case "logical":
      return logical;
    case "physical":
      return logicalToPhysical(logical, scale);
    case "screenshot":
      if (!shot) throw new ComputerUseError("invalid_request", "logical→screenshot needs the screenshot");
      return logicalToScreenshot(logical, shot);
    case "normalized": {
      if (!shot) throw new ComputerUseError("invalid_request", "logical→normalized needs the screenshot");
      return screenshotToNormalized(logicalToScreenshot(logical, shot), shot.width, shot.height);
    }
  }
}

/**
 * Resolve an action's PointInSpace (any space) into *screenshot pixel*
 * coordinates, which is the currency shared by adapters, fusion logic
 * and evidence records.
 */
export function toScreenshotSpace(p: { x: number; y: number; space?: string }, shot: Screenshot): Point {
  return convertPoint(p, (p.space ?? "screenshot") as CoordinateSpace, "screenshot", { screenshot: shot });
}

export function rectCenter(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function pointInRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
