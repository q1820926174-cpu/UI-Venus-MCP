/**
 * X11 command builders + output parsers for wmctrl / xdotool / screenshot
 * tools. Pure functions wherever possible so they are unit-testable without
 * a Linux host.
 *
 * Coordinate space: X screen pixels. The screenshot pixel space equals the
 * logical space (scale 1 assumption — fractional scaling is NOT compensated;
 * the adapter documents this limitation in capabilities.notes).
 */
import type { Rect, WindowInfo } from "../../core/types.js";
import { ComputerUseError } from "../../core/errors.js";

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

/** Probe precedence: ImageMagick `import` > `scrot` > `gnome-screenshot`. */
export const X11_SCREENSHOT_TOOLS = ["import", "scrot", "gnome-screenshot"] as const;
export type X11ScreenshotTool = (typeof X11_SCREENSHOT_TOOLS)[number];

export function pickScreenshotTool(tools: Record<string, boolean>): X11ScreenshotTool | null {
  for (const tool of X11_SCREENSHOT_TOOLS) {
    if (tools[tool]) return tool;
  }
  return null;
}

export interface ScreenshotTarget {
  /** hex ("0x05a00003") or decimal X window id for window captures */
  windowId?: string;
  /** region in screen pixels */
  region?: Rect;
}

/**
 * Build the argument list for a capture (the output file path is appended by
 * the caller). Returns null when the chosen tool cannot serve the requested
 * target — the adapter must then throw an honest `restricted` error instead
 * of silently capturing something else.
 */
export function buildScreenshotArgs(tool: X11ScreenshotTool, target: ScreenshotTarget = {}): string[] | null {
  const { windowId, region } = target;
  switch (tool) {
    case "import": {
      if (windowId) return ["-window", windowId];
      const args = ["-window", "root"];
      if (region) args.push("-crop", `${Math.round(region.width)}x${Math.round(region.height)}+${Math.round(region.x)}+${Math.round(region.y)}`);
      return args;
    }
    case "scrot": {
      if (windowId) return null; // scrot cannot address a window by id (only -u focused)
      if (region) return ["-a", `${Math.round(region.x)},${Math.round(region.y)},${Math.round(region.width)},${Math.round(region.height)}`];
      return [];
    }
    case "gnome-screenshot": {
      if (region) return null; // no region capture support
      if (windowId) return ["-w"]; // -w = currently active window (approximation; adapter annotates)
      return [];
    }
    default:
      return null;
  }
}

/** Read width/height straight out of the PNG IHDR header (big-endian @16/20). */
export function readPngSize(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    throw new ComputerUseError("provider_error", "screenshot tool did not produce a PNG image");
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ---------------------------------------------------------------------------
// wmctrl
// ---------------------------------------------------------------------------

/**
 * `wmctrl -l -G` columns: id desktop pid host x y w h title…
 * wmctrl right-pads columns with spaces and the title may contain anything,
 * so the first 8 fields are matched by regex and the remainder is the title.
 */
export function parseWmctrlListG(out: string): WindowInfo[] {
  const windows: WindowInfo[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const m = line.match(/^(\S+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*(.*)$/);
    if (!m) continue;
    windows.push({
      id: m[1]!,
      title: m[9] ?? "",
      bounds: {
        x: Number(m[5]),
        y: Number(m[6]),
        width: Number(m[7]),
        height: Number(m[8]),
      },
      // desktop -1 means sticky, not minimized — wmctrl -lG does not expose
      // minimized state, so we honestly leave it undefined.
      focused: undefined,
    });
  }
  return windows;
}

export interface WmctrlXEntry {
  /** hex window id, e.g. 0x05a00003 */
  id: string;
  desktop: number | null;
  /** WM_CLASS "instance.class", e.g. "navigator.firefox" */
  wmClass: string;
  host: string;
  title: string;
}

/** `wmctrl -l -x` columns: id desktop wmclass host title… */
export function parseWmctrlListX(out: string): WmctrlXEntry[] {
  const entries: WmctrlXEntry[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const m = line.match(/^(\S+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (!m) continue;
    const desktop = Number.parseInt(m[2] ?? "", 10);
    entries.push({
      id: m[1]!,
      desktop: Number.isFinite(desktop) ? desktop : null,
      wmClass: m[3] ?? "",
      host: m[4] ?? "",
      title: m[5] ?? "",
    });
  }
  return entries;
}

/** wmctrl commands (window id addressed via -i so hex/decimal are explicit). */
export function buildFocusArgs(windowId?: string, windowTitle?: string, wmClass?: string): string[] {
  if (windowId) return ["-i", "-a", windowId];
  if (wmClass) return ["-x", "-a", wmClass];
  return ["-a", windowTitle ?? ""];
}

export function buildCloseArgs(windowId?: string, windowTitle?: string): string[] {
  if (windowId) return ["-i", "-c", windowId];
  return ["-c", windowTitle ?? ""];
}

/** xdotool prints window ids in decimal; wmctrl wants hex "0x05a00003". */
export function toWmctrlId(id: string): string {
  if (/^0x[0-9a-f]+$/i.test(id)) return `0x${id.slice(2).toLowerCase()}`;
  const n = Number.parseInt(id, 10);
  if (!Number.isFinite(n) || n < 0) return id;
  return `0x${n.toString(16).padStart(8, "0")}`;
}

// ---------------------------------------------------------------------------
// xdotool
// ---------------------------------------------------------------------------

/** Parse `xdotool getactivewindow` output (decimal id). */
export function parseXdotoolWindowId(out: string): string | null {
  const t = out.trim();
  return /^\d+$/.test(t) ? t : null;
}

/** Parse `xdotool getactivewindow getwindowgeometry --shell` (KEY=VALUE lines). */
export function parseXdotoolGeometryShell(out: string): Rect | null {
  const kv: Record<string, number> = {};
  for (const line of out.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(\-?\d+)\s*$/);
    if (m) kv[m[1]!] = Number(m[2]);
  }
  if (kv.X === undefined || kv.Y === undefined || kv.WIDTH === undefined || kv.HEIGHT === undefined) return null;
  return { x: kv.X, y: kv.Y, width: kv.WIDTH, height: kv.HEIGHT };
}

/** Parse `xdotool getdisplaygeometry` output: "1920 1080". */
export function parseXdotoolDisplayGeometry(out: string): { width: number; height: number } | null {
  const m = out.trim().match(/^(\d+)\s+(\d+)$/);
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

// ---------------------------------------------------------------------------
// xrandr
// ---------------------------------------------------------------------------

export interface XrandrMonitor {
  name: string;
  primary: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Parse `xrandr --query` connected monitor lines (device pixels == logical at scale 1). */
export function parseXrandrMonitors(out: string): XrandrMonitor[] {
  const monitors: XrandrMonitor[] = [];
  const re = /^(\S+) connected (?:primary )?(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/;
  for (const line of out.split("\n")) {
    const m = line.match(re);
    if (!m) continue;
    monitors.push({
      name: m[1]!,
      primary: /\bprimary\b/.test(line),
      x: Number(m[4]),
      y: Number(m[5]),
      width: Number(m[2]),
      height: Number(m[3]),
    });
  }
  return monitors;
}

// ---------------------------------------------------------------------------
// xdotool input builders (single invocations; xdotool chains commands)
// ---------------------------------------------------------------------------

export const X11_MOUSE_BUTTONS = { left: 1, middle: 2, right: 3, wheelUp: 4, wheelDown: 5, wheelLeft: 6, wheelRight: 7 } as const;

export function buildMouseMove(x: number, y: number): string[] {
  return ["mousemove", String(Math.round(x)), String(Math.round(y))];
}

export function buildClick(x: number, y: number, button: "left" | "right" = "left", clicks = 1): string[] {
  const btn = button === "right" ? X11_MOUSE_BUTTONS.right : X11_MOUSE_BUTTONS.left;
  const args: string[] = [...buildMouseMove(x, y), "click"];
  if (clicks > 1) args.push("--repeat", String(clicks));
  return [...args, String(btn)];
}

export function buildMouseDown(x: number, y: number, button: "left" | "right" = "left"): string[] {
  return [...buildMouseMove(x, y), "mousedown", String(button === "right" ? X11_MOUSE_BUTTONS.right : X11_MOUSE_BUTTONS.left)];
}

export function buildMouseUp(x: number, y: number, button: "left" | "right" = "left"): string[] {
  return [...buildMouseMove(x, y), "mouseup", String(button === "right" ? X11_MOUSE_BUTTONS.right : X11_MOUSE_BUTTONS.left)];
}

/** One xdotool invocation: move → mousedown → interpolated moves → mouseup. */
export function buildDrag(from: { x: number; y: number }, to: { x: number; y: number }, steps = 16): string[] {
  const args: string[] = [...buildMouseMove(from.x, from.y), "mousedown", String(X11_MOUSE_BUTTONS.left)];
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    args.push("mousemove", String(Math.round(x)), String(Math.round(y)));
  }
  args.push("mouseup", String(X11_MOUSE_BUTTONS.left));
  return args;
}

const SCROLL_BUTTONS = { up: X11_MOUSE_BUTTONS.wheelUp, down: X11_MOUSE_BUTTONS.wheelDown, left: X11_MOUSE_BUTTONS.wheelLeft, right: X11_MOUSE_BUTTONS.wheelRight } as const;

/** Scroll via wheel buttons 4/5 (vertical) and 6/7 (horizontal). */
export function buildScroll(x: number, y: number, direction: "up" | "down" | "left" | "right", amount = 3): string[] {
  const clicks = Math.max(1, Math.round(amount));
  const args: string[] = [...buildMouseMove(x, y), "click"];
  if (clicks > 1) args.push("--repeat", String(clicks));
  return [...args, String(SCROLL_BUTTONS[direction])];
}

// ---------------------------------------------------------------------------
// Keyboard: unified key names → X keysyms
// ---------------------------------------------------------------------------

const KEY_NAME_MAP: Record<string, string> = {
  enter: "Return",
  return: "Return",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  space: "space",
  backspace: "BackSpace",
  delete: "BackSpace",
  del: "Delete",
  forwarddelete: "Delete",
  home: "Home",
  end: "End",
  pageup: "Page_Up",
  pagedown: "Page_Down",
  left: "Left",
  right: "Right",
  up: "Up",
  down: "Down",
  insert: "Insert",
  menu: "Menu",
  pause: "Pause",
  printscreen: "Print",
  volumeup: "XF86AudioRaiseVolume",
  volumedown: "XF86AudioLowerVolume",
  volumemute: "XF86AudioMute",
};

/** Map a unified key name to an X keysym; unknown names pass through as-is. */
export function mapKeyName(key: string): string {
  const k = key.trim().toLowerCase();
  const mapped = KEY_NAME_MAP[k];
  if (mapped) return mapped;
  const fkey = k.match(/^f(\d{1,2})$/);
  if (fkey) return `F${fkey[1]}`;
  return key.trim();
}

const MODIFIER_ALIASES: Record<string, string> = {
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
  cmd: "super",
  command: "super",
  meta: "super",
  super: "super",
  win: "super",
};

export function buildKey(key: string): string[] {
  return ["key", mapKeyName(key)];
}

/** Build "ctrl+c" style combos: modifiers first, last key is the tap. */
export function buildCombo(keys: string[]): string[] {
  const parts = keys.map((k) => MODIFIER_ALIASES[k.trim().toLowerCase()] ?? mapKeyName(k));
  return ["key", parts.join("+")];
}

export function buildTypeText(text: string): string[] {
  return ["type", "--clearmodifiers", "--", text];
}
