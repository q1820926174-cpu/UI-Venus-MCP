/**
 * Screen capture + display info for Windows (screen.ps1 bridge).
 *
 * Physical pixels are canonical: the PS session calls SetProcessDPIAware()
 * before any GDI use, so SystemInformation.VirtualScreen, Screen.Bounds and
 * CopyFromScreen all agree on physical pixels. Multi-monitor is covered by
 * the virtual screen (origin may be negative on left-placed monitors).
 *
 * Each capture returns cheap content stats (avg R/G/B/luma, black ratio)
 * so callers can honestly report a locked/black session instead of a
 * fake "successful" screenshot.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DisplayInfo } from "../../core/types.js";
import { ComputerUseError } from "../../core/errors.js";
import { encodeArgs, parsePsJson, runPowerShell } from "./powershell.js";

export interface ForegroundWindowInfo {
  pid: number;
  process: string;
  title: string;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface WindowsScreenInfo {
  virtualScreen: { x: number; y: number; width: number; height: number };
  displays: {
    id: string;
    deviceName?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    primary: boolean;
  }[];
  dpi: number;
  scale: number;
  dpiMethod?: string;
  foreground?: ForegroundWindowInfo | null;
}

export interface CaptureStats {
  file?: string;
  originKind?: string;
  origin: { x: number; y: number };
  width: number;
  height: number;
  avgR?: number;
  avgG?: number;
  avgB?: number;
  avgLuma?: number;
  sampled?: number;
  blackRatio?: number;
}

/** Display geometry + DPI scale (screen.ps1 info mode). */
export async function getScreenInfo(): Promise<WindowsScreenInfo> {
  const r = await runPowerShell("screen.ps1", ["-Mode", "info"], 20_000);
  return parsePsJson<WindowsScreenInfo>("screen.ps1", r);
}

/** DisplayInfo list. Physical bounds are canonical; `scale` is informational. */
export async function listDisplays(info?: WindowsScreenInfo): Promise<DisplayInfo[]> {
  const screen = info ?? (await getScreenInfo());
  return screen.displays.map((d) => ({
    id: d.id,
    x: d.x,
    y: d.y,
    width: d.width,
    height: d.height,
    scale: screen.scale > 0 ? screen.scale : 1,
    primary: d.primary,
  }));
}

/** Foreground window (pid/process/title/physical bounds) or null. */
export async function getForegroundWindow(info?: WindowsScreenInfo): Promise<ForegroundWindowInfo | null> {
  const screen = info ?? (await getScreenInfo());
  return screen.foreground ?? null;
}

export interface CaptureOptions {
  /** physical-pixel region (clamped to the virtual screen by screen.ps1) */
  region?: { x: number; y: number; width: number; height: number };
  /** index into Screen.AllScreens */
  displayId?: string | number;
}

/**
 * Capture the whole virtual screen, a display or a region as PNG.
 * Throws ComputerUseError when GDI capture fails (e.g. session without a
 * desktop). A *black* capture is a real capture — check `stats.blackRatio`.
 */
export async function captureScreen(options: CaptureOptions = {}): Promise<{ png: Buffer; stats: CaptureStats }> {
  const dir = await mkdtemp(join(tmpdir(), "cumcp-win-"));
  const file = join(dir, "screen.png");
  try {
    const payload: Record<string, unknown> = {};
    if (options.region) payload.region = options.region;
    if (options.displayId !== undefined && options.displayId !== "") payload.displayId = Number(options.displayId);
    const r = await runPowerShell("screen.ps1", ["-Mode", "capture", "-ArgsJson", encodeArgs(payload), "-OutFile", file], 30_000);
    const stats = parsePsJson<CaptureStats>("screen.ps1", r);
    const png = await readFile(file);
    if (png.length < 100) {
      throw new ComputerUseError("internal_error", "screen.ps1 produced an empty PNG", { details: { bytes: png.length } });
    }
    return { png, stats };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Cheap capability probe: can this session capture at all? */
export async function probeCapture(): Promise<boolean> {
  try {
    const { png } = await captureScreen({ region: { x: 0, y: 0, width: 64, height: 64 } });
    return png.length > 100;
  } catch {
    return false;
  }
}
