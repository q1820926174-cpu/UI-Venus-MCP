/**
 * idb (Meta's iOS Development Bridge) wrappers — accessibility tree and
 * touch input for SIMULATORS (spec §10, simulator kind).
 *
 * `xcrun simctl` has no accessibility dump, so the UI tree on simulators
 * comes from idb when it is installed:
 *   - `idb ui describe-all --udid <udid>` → flat JSON array of AX elements
 *     (AXLabel / type / AXFrame …), in DFS pre-order → rebuilt into a
 *     UINode tree by frame containment.
 *   - `idb describe --udid <udid>` → device info incl. screen_dimensions
 *     {width, height, scale} — the only simctl-era way to learn the
 *     screenshot scale (points→pixels) without WDA.
 *   - `idb ui tap|text|swipe|key` → raw touch/keyboard input.
 *
 * All execution is injectable (RunFn) for hermetic unit tests. If idb is
 * missing, the adapter reports accessibility=false with an install hint
 * and tree/locate degrade to vision-only — documented, never faked.
 */
import type { Rect, UINode } from "../../core/types.js";
import { ComputerUseError } from "../../core/errors.js";
import type { RunFn } from "./simctl.js";
import { run as defaultRun } from "../exec.js";

export interface IdbOptions {
  run?: RunFn;
  /** idb binary; default "idb" resolved via PATH (`which idb`). */
  idbPath?: string;
  timeoutMs?: number;
}

export interface IdbScreenDimensions {
  width: number;
  height: number;
  scale: number;
}

export interface IdbAxElement {
  role: string;
  label?: string;
  value?: string;
  placeholder?: string;
  identifier?: string;
  frame?: Rect;
  enabled: boolean;
  raw: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Shared iOS AX helpers (used by both idb.ts and wda.ts)              */
/* ------------------------------------------------------------------ */

/** Coerce any of the frame encodings seen in idb/WDA output into a Rect. */
export function coerceFrame(v: unknown): Rect | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const x = num(o.x);
    const y = num(o.y);
    const w = num(o.width);
    const h = num(o.height);
    if (x !== undefined && y !== undefined && w !== undefined && h !== undefined) return { x, y, width: w, height: h };
    return undefined;
  }
  if (typeof v === "string") {
    // CGRect description: "{0, 0; 375, 812}"  or  "0, 0, 375, 812"
    const m = v.match(/\{\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*;\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\}/);
    const nums = m
      ? [m[1], m[2], m[3], m[4]]
      : v.split(",").map((s) => s.trim()).filter((s) => /^-?[\d.]+$/.test(s));
    if (nums.length === 4) {
      const [x, y, w, h] = nums.map(Number) as [number, number, number, number];
      if ([x, y, w, h].every((n) => Number.isFinite(n))) return { x, y, width: w, height: h };
    }
  }
  return undefined;
}

function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Map native AX/XCUITest type names ("XCUIElementTypeButton", "Button")
 * to the unified lowercase role vocabulary. */
export function normalizeIosRole(type: unknown): string {
  const raw = String(type ?? "").replace(/^XCUIElementType/, "").trim().toLowerCase();
  if (!raw) return "unknown";
  switch (raw) {
    case "statictext": return "text";
    case "textfield": return "textfield";
    case "securetextfield": return "securetextfield";
    case "textview": return "textarea";
    case "searchfield": return "searchfield";
    case "segmentedcontrol": return "segmentedcontrol";
    case "pageindicator": return "indicator";
    case "tabbar": return "tabbar";
    case "navigationbar": return "navbar";
    default: return raw;
  }
}

const IOS_CLICKABLE = new Set(["button", "cell", "switch", "checkbox", "link", "key", "tab", "menu", "icon", "alertbutton"]);
const IOS_EDITABLE = new Set(["textfield", "securetextfield", "textarea", "searchfield"]);

export function isClickableRole(role: string): boolean {
  return IOS_CLICKABLE.has(role) || role.endsWith("button");
}

export function isEditableRole(role: string): boolean {
  return IOS_EDITABLE.has(role);
}

/**
 * Rebuild a UINode tree from a FLAT element list that is ordered DFS
 * pre-order (both `idb ui describe-all` and WDA's JSON source behave this
 * way in practice). A node becomes a child of the nearest preceding node
 * whose frame contains it. Elements without frames attach at the current
 * stack top (or the root) — containment of unknown frames is not guessed.
 */
export function buildTreeByContainment(
  entries: Array<{ node: UINode; frame?: Rect }>,
): UINode | null {
  const roots: UINode[] = [];
  const stack: Array<{ node: UINode; frame?: Rect }> = [];
  for (const entry of entries) {
    while (stack.length > 0 && !contains(stack[stack.length - 1]!.frame, entry.frame)) stack.pop();
    if (stack.length === 0) roots.push(entry.node);
    else (stack[stack.length - 1]!.node.children ??= []).push(entry.node);
    stack.push(entry);
  }
  return roots[0] ?? null;
}

const EPSILON = 0.5; // points; tolerate 1px rounding differences

export function contains(outer: Rect | undefined, inner: Rect | undefined): boolean {
  if (!outer || !inner) return false; // unknown frames never claim containment
  return (
    inner.x >= outer.x - EPSILON &&
    inner.y >= outer.y - EPSILON &&
    inner.x + inner.width <= outer.x + outer.width + EPSILON &&
    inner.y + inner.height <= outer.y + outer.height + EPSILON
  );
}

/* ------------------------------------------------------------------ */
/* Parsing (pure, fixture-tested)                                      */
/* ------------------------------------------------------------------ */

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/** Parse one `idb ui describe-all` element. Key names vary between idb
 * versions; accept AX* and bare spellings. */
export function parseIdbElement(el: Record<string, unknown>): IdbAxElement {
  const label = str(el.AXLabel) ?? str(el.label);
  return {
    role: normalizeIosRole(el.type ?? el.AXType),
    label,
    value: str(el.AXValue) ?? str(el.value),
    placeholder: str(el.AXPlaceholderValue) ?? str(el.placeholderValue),
    identifier: str(el.AXIdentifier) ?? str(el.identifier),
    frame: coerceFrame(el.AXFrame ?? el.frame),
    enabled: el.isEnabled === undefined ? true : el.isEnabled === true || el.isEnabled === "true" || el.isEnabled === 1,
    raw: el,
  };
}

/** Parse `idb ui describe-all` stdout (JSON array; tolerate leading log noise). */
export function parseDescribeAll(text: string): IdbAxElement[] {
  const start = text.indexOf("[");
  if (start < 0) {
    throw new ComputerUseError("provider_error", "idb ui describe-all did not return a JSON array");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch (e) {
    throw new ComputerUseError("provider_error", "idb ui describe-all returned invalid JSON", { cause: e });
  }
  if (!Array.isArray(parsed)) {
    throw new ComputerUseError("provider_error", "idb ui describe-all JSON is not an array");
  }
  const out: IdbAxElement[] = [];
  for (const item of parsed) {
    if (item !== null && typeof item === "object") out.push(parseIdbElement(item as Record<string, unknown>));
  }
  return out;
}

/** Flat describe-all list → UINode tree (bounds in logical points). */
export function describeAllToTree(elements: IdbAxElement[]): UINode | null {
  return buildTreeByContainment(
    elements.map((el, i) => ({
      frame: el.frame,
      node: {
        id: `ios:idb/${i}`,
        source: "xcuitest" as const,
        role: el.role,
        name: el.label ?? el.placeholder,
        value: el.value,
        bounds: el.frame,
        clickable: isClickableRole(el.role) && el.enabled,
        editable: isEditableRole(el.role) && el.enabled,
        enabled: el.enabled,
        attributes: { origin: "idb", identifier: el.identifier ?? null, axType: typeof el.raw.type === "string" ? el.raw.type : null, boundsSpace: "logical" },
      },
    })),
  );
}

/** Parse `idb describe --udid <udid>` (JSON) for the screen metrics. */
export function parseIdbDescribe(text: string): { screen?: IdbScreenDimensions; raw: Record<string, unknown> } {
  const start = text.indexOf("{");
  if (start < 0) return { raw: {} };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text.slice(start)) as Record<string, unknown>;
  } catch {
    return { raw: {} };
  }
  const sd = parsed.screen_dimensions;
  let screen: IdbScreenDimensions | undefined;
  if (sd && typeof sd === "object") {
    const o = sd as Record<string, unknown>;
    const width = num(o.width);
    const height = num(o.height);
    const scale = num(o.scale);
    if (width !== undefined && height !== undefined && scale !== undefined) {
      screen = { width, height, scale };
    }
  }
  return { screen, raw: parsed };
}

/* ------------------------------------------------------------------ */
/* CLI wrappers (injectable)                                           */
/* ------------------------------------------------------------------ */

export async function probeIdb(opts: IdbOptions = {}): Promise<{ ok: boolean; path?: string; error?: string }> {
  const run = opts.run ?? defaultRun;
  const idbPath = opts.idbPath ?? "idb";
  const r = await run("which", [idbPath], 10_000).catch((e: Error) => ({ code: -1, stdout: "", stderr: e.message }));
  if (r.code === 0 && r.stdout.trim()) return { ok: true, path: r.stdout.trim() };
  return { ok: false, error: r.stderr.trim() || `which ${idbPath} exited ${r.code}` };
}

export class Idb {
  private readonly run: RunFn;
  private readonly idb: string;
  private readonly timeoutMs: number;

  constructor(opts: IdbOptions = {}) {
    this.run = opts.run ?? defaultRun;
    this.idb = opts.idbPath ?? "idb";
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private async exec(args: string[]): Promise<string> {
    const r = await this.run(this.idb, args, this.timeoutMs);
    if (r.code !== 0) {
      throw new ComputerUseError("provider_error", `idb ${args[0]} ${args[1] ?? ""} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    }
    return r.stdout;
  }

  /** Flat AX elements for the current screen (logical points). */
  async describeAll(udid: string): Promise<IdbAxElement[]> {
    return parseDescribeAll(await this.exec(["ui", "describe-all", "--udid", udid]));
  }

  async describeAllTree(udid: string): Promise<UINode | null> {
    return describeAllToTree(await this.describeAll(udid));
  }

  async describeDevice(udid: string): Promise<{ screen?: IdbScreenDimensions; raw: Record<string, unknown> }> {
    return parseIdbDescribe(await this.exec(["describe", "--udid", udid]));
  }

  async tap(udid: string, x: number, y: number): Promise<void> {
    await this.exec(["ui", "tap", String(Math.round(x)), String(Math.round(y)), "--udid", udid]);
  }

  /** Double tap = two rapid taps (idb has no native double-tap subcommand). */
  async doubleTap(udid: string, x: number, y: number): Promise<void> {
    await this.tap(udid, x, y);
    await this.tap(udid, x, y);
  }

  async text(udid: string, text: string): Promise<void> {
    await this.exec(["ui", "text", text, "--udid", udid]);
  }

  async swipe(udid: string, fromX: number, fromY: number, toX: number, toY: number, durationMs = 300): Promise<void> {
    await this.exec([
      "ui", "swipe",
      String(Math.round(fromX)), String(Math.round(fromY)),
      String(Math.round(toX)), String(Math.round(toY)),
      "--duration", String(Math.max(0.01, durationMs / 1000)),
      "--udid", udid,
    ]);
  }

  /** Long-press approximation: zero-length swipe held for `durationMs`. */
  async longPress(udid: string, x: number, y: number, durationMs = 800): Promise<void> {
    await this.swipe(udid, x, y, x, y, durationMs);
  }

  /** Send a HID usage code (e.g. keyboard keys). */
  async key(udid: string, hidUsage: number): Promise<void> {
    await this.exec(["ui", "key", String(hidUsage), "--udid", udid]);
  }
}

export { IOS_CLICKABLE, IOS_EDITABLE };
