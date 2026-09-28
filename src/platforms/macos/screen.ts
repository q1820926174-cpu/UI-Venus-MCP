/**
 * macOS native helpers: displays, screenshots, AX tree (via System Events
 * AppleScript — the raw AXUIElement C API is blocked inside some sandboxed
 * runtimes, while System Events works with the same Accessibility grant),
 * and CGEvent input (JXA).
 *
 * Coordinates on macOS are logical points, origin = top-left of the main
 * display (System Events `position` and CGEvent global space agree).
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DisplayInfo } from "../../core/types.js";
import { ComputerUseError } from "../../core/errors.js";
import { jxa, run } from "../exec.js";

/**
 * Displays: main display comes from CoreGraphics directly (exact bounds +
 * pixel scale). Secondary displays are enumerated from system_profiler
 * (pixel + UI resolution give the scale); their logical origin is
 * approximated by stacking to the right of the main display — a documented
 * v1 limitation for exotic multi-monitor arrangements.
 */
export async function listDisplays(): Promise<DisplayInfo[]> {
  const out = await jxa(`
    ObjC.import("CoreGraphics");
    const main = $.CGMainDisplayID();
    const b = $.CGDisplayBounds(main);
    const pw = $.CGDisplayPixelsWide(main);
    const ph = $.CGDisplayPixelsHigh(main);
    "main|" + main + "|" + b.origin.x + "|" + b.origin.y + "|" + b.size.width + "|" + b.size.height + "|" + pw + "|" + ph;
  `);
  const [, id, x, y, w, h, pw, ph] = out.trim().split("|");
  const displays: DisplayInfo[] = [
    {
      id: id!,
      x: Number(x),
      y: Number(y),
      width: Number(w),
      height: Number(h),
      scale: Math.max(1, Math.round((Number(pw) / Number(w)) * 2) / 2),
      primary: true,
    },
  ];

  // Secondary displays (best effort, skipped on any parse problem)
  try {
    const r = await run("/usr/sbin/system_profiler", ["SPDisplaysDataType", "-json"], 20_000);
    if (r.code === 0) {
      const data = JSON.parse(r.stdout) as {
        SPDisplaysDataType?: { spdisplays_ndrvs?: Record<string, unknown>[] }[];
      };
      let cursorX = displays[0]!.x + displays[0]!.width;
      for (const _gpu of data.SPDisplaysDataType ?? []) {
        for (const disp of _gpu.spdisplays_ndrvs ?? []) {
          const pixels = String(disp["spdisplays_pixel-resolution"] ?? "");
          const ui = String(disp["_spdisplays_ui-resolution"] ?? pixels);
          const isMain = disp["spdisplays_main"] === "spdisplays_yes";
          if (isMain) continue;
          const [pw2, ph2] = pixels.split("x").map(Number);
          const [uw2, uh2] = ui.split("x").map(Number);
          if (!pw2 || !ph2 || !uw2 || !uh2) continue;
          displays.push({
            id: String(disp["spdisplays_display-ID"] ?? `secondary-${displays.length}`),
            x: cursorX,
            y: 0,
            width: uw2,
            height: uh2,
            scale: Math.max(1, Math.round((pw2 / uw2) * 2) / 2),
            primary: false,
          });
          cursorX += uw2;
        }
      }
    }
  } catch {
    // single-display setups never hit this path; notes stay honest via capabilities
  }
  return displays;
}

/**
 * Capture a screenshot with `screencapture`.
 * @param region logical region (x,y,w,h) — omit for the whole main display
 * @returns raw PNG buffer
 */
export async function captureDisplay(region?: { x: number; y: number; width: number; height: number }): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "cumcp-"));
  const file = join(dir, "screen.png");
  try {
    const args = ["-x", "-t", "png"];
    if (region) args.push(`-R${Math.round(region.x)},${Math.round(region.y)},${Math.round(region.width)},${Math.round(region.height)}`);
    args.push(file);
    const r = await run("/usr/sbin/screencapture", args, 15_000);
    if (r.code !== 0) {
      throw new ComputerUseError("permission_required", `screencapture failed: ${r.stderr.trim()}`, {
        hint: "Grant Screen Recording permission to the terminal/host app in System Settings → Privacy & Security.",
      });
    }
    return await readFile(file);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** True when the frontmost app can be inspected via System Events. */
export async function checkAccessibilityPermission(): Promise<boolean> {
  try {
    const r = await run("/usr/bin/osascript", [
      "-e",
      'tell application "System Events" to get name of first process whose frontmost is true',
    ], 10_000);
    return r.code === 0 && r.stdout.trim().length > 0;
  } catch {
    return false;
  }
}
