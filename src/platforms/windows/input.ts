/**
 * SendInput-based mouse + keyboard for Windows (input.ps1 bridge).
 *
 * All coordinates are PHYSICAL screen pixels (the PS session is DPI-aware;
 * input.ps1 converts to SendInput's normalized 0..65535 virtual-screen space).
 *
 * Honesty: every call checks SendInput's return value (events actually
 * injected) — 0 injected events surfaces as ComputerUseError("restricted").
 * Mouse ops read the cursor position back and include it in the result.
 */
import { encodeArgs, parsePsJson, runPowerShell } from "./powershell.js";

export interface InputProbeResult {
  ok: boolean;
  mode: string;
  requested?: { x: number; y: number };
  cursor?: { x: number; y: number } | null;
  button?: string;
  clicks?: number;
  direction?: string;
  notches?: number;
  units?: number;
  key?: string;
  modifiers?: string[];
  from?: { x: number; y: number };
  to?: { x: number; y: number };
}

async function runInput(mode: string, payload: Record<string, unknown>, timeoutMs = 20_000): Promise<InputProbeResult> {
  const r = await runPowerShell("input.ps1", ["-Mode", mode, "-ArgsJson", encodeArgs(payload)], timeoutMs);
  return parsePsJson<InputProbeResult>("input.ps1", r);
}

export async function mouseMove(x: number, y: number): Promise<InputProbeResult> {
  return runInput("move", { x: Math.round(x), y: Math.round(y) });
}

export async function mouseClick(
  x: number,
  y: number,
  button: "left" | "right" = "left",
  clicks = 1,
): Promise<InputProbeResult> {
  return runInput("click", { x: Math.round(x), y: Math.round(y), button, clicks });
}

export async function mouseDrag(
  from: { x: number; y: number },
  to: { x: number; y: number },
  durationMs = 400,
): Promise<InputProbeResult> {
  return runInput("drag", {
    fromX: Math.round(from.x),
    fromY: Math.round(from.y),
    toX: Math.round(to.x),
    toY: Math.round(to.y),
    durationMs: Math.max(50, Math.round(durationMs)),
  }, 60_000);
}

export async function mouseScroll(
  x: number,
  y: number,
  direction: "up" | "down" | "left" | "right",
  amount = 3,
): Promise<InputProbeResult> {
  return runInput("scroll", { x: Math.round(x), y: Math.round(y), direction, amount });
}

/** Unicode-safe typing via KEYEVENTF_UNICODE (ASCII + CJK + emoji). */
export async function typeText(text: string): Promise<InputProbeResult> {
  return runInput("type", { text }, 60_000);
}

/** Virtual-key press, optionally with modifiers ("ctrl", "shift", "alt", "win"). */
export async function pressKey(key: string, modifiers: string[] = []): Promise<InputProbeResult> {
  return runInput("key", { key, modifiers });
}
