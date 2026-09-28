/**
 * Wayland backend helpers — honest by construction.
 *
 * Wayland's security model deliberately blocks global screen capture and
 * global input injection. This module therefore:
 *  - detects the tools that DO work per compositor family:
 *      grim          (wlroots-family) — non-interactive capture
 *      wtype         — compositor-native keyboard injection (no pointer)
 *      ydotool       — uinput-based keyboard + pointer, but ONLY with the
 *                      ydotoold daemon running and /dev/uinput access
 *  - builds restricted errors with actionable hints whenever a tool is
 *    missing, explicitly mentioning the xdg-desktop-portal Screenshot
 *    interface (works everywhere, but requires interactive user consent).
 * It NEVER fakes execution: if no tool exists the action throws `restricted`.
 */
import type { Rect } from "../../core/types.js";
import { ComputerUseError } from "../../core/errors.js";
import { mapKeyName } from "./x11.js";

// ---------------------------------------------------------------------------
// Honest restricted errors
// ---------------------------------------------------------------------------

export function waylandScreenshotError(): ComputerUseError {
  return new ComputerUseError("restricted", "Wayland: global screen capture is blocked by the compositor security model", {
    details: { session: "wayland", portal: "org.freedesktop.portal.Screenshot" },
    hint: "Install grim (wlroots-family compositors: sway, hyprland, river, …) for non-interactive capture. The xdg-desktop-portal org.freedesktop.portal.Screenshot interface also works on GNOME/KDE, but requires interactive user consent for every capture.",
  });
}

export function waylandPointerError(what: string): ComputerUseError {
  return new ComputerUseError("restricted", `${what}: Wayland compositors do not allow X11-style global pointer injection`, {
    hint: "Install ydotool AND run its ydotoold daemon with /dev/uinput access (add the user to the 'input' group), or act on semantic AT-SPI elements instead of raw coordinates.",
  });
}

export function waylandKeyboardError(what: string): ComputerUseError {
  return new ComputerUseError("restricted", `${what}: no Wayland keyboard injection tool found`, {
    hint: "Install wtype (compositor-native) or ydotool with ydotoold running and /dev/uinput permissions (input group).",
  });
}

export function waylandWindowControlError(what: string): ComputerUseError {
  return new ComputerUseError("restricted", `${what}: window management is compositor-specific on Wayland and not supported by this adapter`, {
    hint: "Use the compositor's own IPC (swaymsg, hyprctl, kdotool, …) or drive the application through its AT-SPI interface.",
  });
}

// ---------------------------------------------------------------------------
// grim capture
// ---------------------------------------------------------------------------

/** grim output geometry: "-g <x>,<y> <width>x<height>". Empty args = full output. */
export function buildGrimArgs(region?: Rect): string[] {
  if (!region) return [];
  const { x, y, width, height } = region;
  return ["-g", `${Math.round(x)},${Math.round(y)} ${Math.round(width)}x${Math.round(height)}`];
}

// ---------------------------------------------------------------------------
// wtype (compositor-native keyboard injection; no pointer support)
// ---------------------------------------------------------------------------

/** Type literal text: `wtype -- <text>` (text may start with "-"). */
export function buildWtypeText(text: string): string[] {
  return ["--", text];
}

/** Press+release one keysym: `wtype -k Return`. */
export function buildWtypeKey(key: string): string[] {
  return ["-k", mapKeyName(key)];
}

/** Hold modifiers, tap the last key, release modifiers: `-M ctrl -P c -p c -m ctrl`. */
export function buildWtypeCombo(keys: string[]): string[] {
  const mods = keys.slice(0, -1).map((k) => MOD_ALIASES[k.trim().toLowerCase()] ?? mapKeyName(k));
  const key = mapKeyName(keys[keys.length - 1] ?? "");
  const args: string[] = [];
  for (const m of mods) args.push("-M", m);
  args.push("-P", key, "-p", key);
  for (const m of [...mods].reverse()) args.push("-m", m);
  return args;
}

const MOD_ALIASES: Record<string, string> = {
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

// ---------------------------------------------------------------------------
// ydotool (uinput-based; requires ydotoold daemon + /dev/uinput access)
// Targets ydotool 1.x CLI syntax; 0.1.x used incompatible arguments.
// ---------------------------------------------------------------------------

export const YDOTOOOL_MOUSE_BUTTONS = { left: "0xC0", right: "0xC1", middle: "0xC2" } as const;

export function buildYdotoolMouseMove(x: number, y: number): string[] {
  return ["mousemove", "-a", String(Math.round(x)), String(Math.round(y))];
}

export function buildYdotoolClick(x: number, y: number, button: "left" | "right" | "middle" = "left"): string[] {
  return [...buildYdotoolMouseMove(x, y), "click", YDOTOOOL_MOUSE_BUTTONS[button]];
}

/** Wheel via `mousemove -w <dx> <dy>` (negative dy scrolls up). */
export function buildYdotoolWheel(dx: number, dy: number): string[] {
  return ["mousemove", "-w", String(Math.round(dx)), String(Math.round(dy))];
}

export function buildYdotoolType(text: string): string[] {
  return ["type", "--", text];
}

/** Linux input-event keycodes used by `ydotool key <code>:[1|0]`. */
export const YDOTOOOL_KEYCODES: Record<string, number> = {
  enter: 28, return: 28, tab: 15, escape: 1, esc: 1, space: 57,
  backspace: 14, delete: 111, del: 111, forwarddelete: 111,
  home: 102, end: 107, pageup: 104, pagedown: 109,
  left: 105, right: 106, up: 103, down: 108,
  ctrl: 29, control: 29, alt: 56, shift: 42, meta: 125, super: 125, cmd: 125, command: 125, win: 125,
  f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65, f8: 66, f9: 67, f10: 68, f11: 87, f12: 88,
  a: 30, b: 48, c: 46, d: 32, e: 18, f: 33, g: 34, h: 35, i: 23, j: 36, k: 37, l: 38, m: 50,
  n: 49, o: 24, p: 25, q: 16, r: 19, s: 31, t: 20, u: 22, v: 47, w: 17, x: 45, y: 21, z: 44,
  "1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10, "0": 11,
};

function ydotoolCode(key: string): number {
  const code = YDOTOOOL_KEYCODES[key.trim().toLowerCase()];
  if (code === undefined) {
    throw new ComputerUseError("invalid_request", `Unknown key "${key}" for ydotool`, {
      hint: "Use named keys (enter, tab, escape, arrows, f1-f12, letters, digits) — ydotool key takes Linux input-event keycodes.",
    });
  }
  return code;
}

/** Press+release one key: `ydotool key 28:1 28:0`. */
export function buildYdotoolKey(key: string): string[] {
  const code = ydotoolCode(key);
  return ["key", `${code}:1`, `${code}:0`];
}

/** Hold modifier keycodes, tap the last key, release modifiers. */
export function buildYdotoolCombo(keys: string[]): string[] {
  const mods = keys.slice(0, -1).map(ydotoolCode);
  const key = ydotoolCode(keys[keys.length - 1] ?? "");
  const args: string[] = ["key"];
  for (const m of mods) args.push(`${m}:1`);
  args.push(`${key}:1`, `${key}:0`);
  for (const m of [...mods].reverse()) args.push(`${m}:0`);
  return args;
}
