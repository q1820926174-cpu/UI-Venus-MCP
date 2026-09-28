/**
 * Linux session / desktop / tool detection (spec §33).
 *
 * Pure + injectable: both `exec` and `env` are parameters so unit tests can
 * fake them — nothing in this module touches the real process environment
 * unless the caller passes it in.
 *
 * Detection rules:
 *  - Wayland wins when XDG_SESSION_TYPE=wayland OR WAYLAND_DISPLAY/WAYLAND_SOCKET is set.
 *  - X11 when XDG_SESSION_TYPE=x11 OR (no wayland marker and) DISPLAY is set.
 *  - tty / unknown otherwise — the adapter must then refuse honestly.
 */
import { run } from "../exec.js";
import type { RunResult } from "../exec.js";

/** Executable seam — matches the signature of platforms/exec.ts `run`. */
export type ExecFn = (cmd: string, args: string[], timeoutMs?: number) => Promise<RunResult>;

export const defaultExec: ExecFn = (cmd, args, timeoutMs) => run(cmd, args, timeoutMs ?? 20_000);

/** The subset of the process environment that drives session detection. */
export interface LinuxEnv {
  XDG_SESSION_TYPE?: string;
  WAYLAND_DISPLAY?: string;
  WAYLAND_SOCKET?: string;
  DISPLAY?: string;
  XDG_CURRENT_DESKTOP?: string;
  XDG_SESSION_DESKTOP?: string;
}

export type SessionType = "x11" | "wayland" | "tty" | "unknown";

export interface SessionDetection {
  session: SessionType;
  /** XDG_CURRENT_DESKTOP verbatim, e.g. "ubuntu:GNOME", "KDE", "sway" */
  desktop: string;
  /** human-readable compositor hint */
  compositor: string;
  /** wlroots-family compositors expose global capture via grim */
  wlrootsFamily: boolean;
}

export const WLROOTS_COMPOSITORS: readonly string[] = [
  "sway",
  "wayfire",
  "labwc",
  "river",
  "cage",
  "phoc",
  "niri",
  "hyprland",
];

export function detectSession(env: LinuxEnv): SessionDetection {
  const declared = (env.XDG_SESSION_TYPE ?? "").trim().toLowerCase();
  const hasWaylandMarker = Boolean((env.WAYLAND_DISPLAY ?? "").trim() || (env.WAYLAND_SOCKET ?? "").trim());
  const desktop = (env.XDG_CURRENT_DESKTOP ?? "").trim();
  const desktops = desktop.toLowerCase().split(":").filter(Boolean);
  const wlrootsFamily = desktops.some((d) => WLROOTS_COMPOSITORS.includes(d));
  const compositor = desktops.length
    ? desktops.map((d) => (d === "gnome" ? "GNOME (Mutter)" : d === "kde" ? "KDE (KWin)" : d)).join("/")
    : "unknown";
  const base = { desktop, compositor, wlrootsFamily };
  if (declared === "wayland" || hasWaylandMarker) return { session: "wayland", ...base };
  if (declared === "tty") return { session: "tty", ...base };
  if (declared === "x11" || (env.DISPLAY ?? "").trim()) return { session: "x11", ...base };
  return { session: "unknown", ...base };
}

/** Tools probed per session type via `which`. python3 is probed in both lists. */
export const X11_TOOLS: readonly string[] = [
  "xdotool",
  "wmctrl",
  "import",
  "scrot",
  "gnome-screenshot",
  "xclip",
  "xsel",
  "xrandr",
  "python3",
  "gtk-launch",
  "gio",
  "killall",
];

export const WAYLAND_TOOLS: readonly string[] = [
  "grim",
  "slurp",
  "wtype",
  "ydotool",
  "ydotoold",
  "wl-copy",
  "wl-paste",
  "python3",
  "gtk-launch",
  "gio",
  "killall",
];

/** Probe tool availability with `which <tool>` (exit 0 = found). Never throws. */
export async function whichAll(exec: ExecFn, tools: readonly string[]): Promise<Record<string, boolean>> {
  const entries = await Promise.all(
    tools.map(async (t) => {
      try {
        const r = await exec("which", [t], 5_000);
        return [t, r.code === 0] as const;
      } catch {
        return [t, false] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * AT-SPI2 python bindings probe: only claim accessibility=true when
 * `python3 -c "import pyatspi"` actually succeeds.
 */
export async function probePyatspi(exec: ExecFn): Promise<boolean> {
  try {
    const r = await exec("python3", ["-c", "import pyatspi"], 15_000);
    return r.code === 0;
  } catch {
    return false;
  }
}

export interface LinuxDetection {
  session: SessionDetection;
  /** tool -> found (per the session's tool list) */
  tools: Record<string, boolean>;
  python3: boolean;
  /** true only when `import pyatspi` works */
  pyatspi: boolean;
}

/** Full environment probe: session type + tool availability + pyatspi. */
export async function probeLinux(exec: ExecFn, env: LinuxEnv = process.env): Promise<LinuxDetection> {
  const session = detectSession(env);
  const toolList = session.session === "wayland" ? WAYLAND_TOOLS : X11_TOOLS;
  const [tools, pyatspi] = await Promise.all([whichAll(exec, toolList), probePyatspi(exec)]);
  return { session, tools, python3: tools.python3 ?? false, pyatspi };
}
