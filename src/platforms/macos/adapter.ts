/**
 * macOS PlatformAdapter — real implementation on this platform.
 *
 * Structured-first:
 *   - AX tree + semantic actions via System Events (AppleScript)
 *   - screenshots via screencapture (Screen Recording permission)
 *   - raw input via CGEvent (Accessibility permission)
 *   - app/window control via System Events + `open`
 * Coordinate space: logical points, origin = top-left of main display.
 * Screenshot pixel space = logical × display scale (Retina aware).
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Capabilities,
  type AppInfo,
  type Observation,
  type ScreenInfo,
  type Screenshot,
  type TargetInfo,
  type WindowInfo,
} from "../../core/types.js";
import type { Action, ActionResult } from "../../core/types-action.js";
import { ComputerUseError, permissionRequired, unsupported } from "../../core/errors.js";
import { processScreenshot } from "../../screenshot/pipeline.js";
import type { ProcessOptions } from "../../screenshot/pipeline.js";
import type { ObserveOptions, PlatformAdapter, ScreenshotOptions, LaunchOptions } from "../adapter.js";
import { osascript } from "../exec.js";
import { captureDisplay, checkAccessibilityPermission, listDisplays } from "./screen.js";
import { readAxTree, axToTree, axClick, axSetValue, axGetAttributes, pathToReference, INTERACTIVE_ROLES, type AxElement } from "./axtree.js";
import * as input from "./input.js";
import type { ElementRef } from "../../core/types.js";

export interface MacosAdapterOptions {
  screenshot?: ProcessOptions;
  axTree?: { maxDepth?: number; maxNodes?: number };
}

interface ResolvedElement {
  path: string;
  processName: string;
  role?: string;
  name?: string;
  bounds?: { x: number; y: number; width: number; height: number };
}

export class MacosAdapter implements PlatformAdapter {
  readonly platform = "macos";
  private info!: TargetInfo;
  private caps!: Capabilities;
  private displays: Awaited<ReturnType<typeof listDisplays>> = [];
  private lastTree: AxElement[] = [];

  constructor(private readonly opts: MacosAdapterOptions = {}) {}

  async open(): Promise<TargetInfo> {
    if (process.platform !== "darwin") throw unsupported("macos adapter", `requires darwin, got ${process.platform}`);
    this.displays = await listDisplays().catch(() => []);
    const accessibility = await checkAccessibilityPermission();
    const screenRecording = await this.probeScreenRecording();
    this.caps = {
      screenshot: screenRecording,
      accessibility,
      dom: false,
      globalInput: accessibility,
      windowControl: accessibility,
      appControl: true,
      clipboard: true,
      multiDisplay: this.displays.length > 1,
      notes: accessibility
        ? []
        : ["Accessibility permission missing: semantic AX actions and CGEvent input will fail until granted."],
    };
    this.info = {
      id: "local:macos",
      platform: "macos",
      type: "local",
      name: `Local macOS (${this.displays[0]?.width ?? "?"}×${this.displays[0]?.height ?? "?"} @${this.displays[0]?.scale ?? 1}x)`,
      details: { displays: this.displays.length, accessibility, screenRecording },
    };
    return this.info;
  }

  private async probeScreenRecording(): Promise<boolean> {
    try {
      const buf = await captureDisplay({ x: 0, y: 0, width: 64, height: 64 });
      return buf.length > 100;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {}

  getTargetInfo(): TargetInfo {
    return this.info;
  }

  getCapabilities(): Capabilities {
    return this.caps;
  }

  private requireScreenshotCapability(): void {
    if (!this.caps.screenshot) {
      throw permissionRequired(
        "Screen Recording",
        "Grant Screen Recording permission to your terminal/host app: System Settings → Privacy & Security → Screen Recording, then restart the app.",
      );
    }
  }

  async getScreenInfo(): Promise<ScreenInfo> {
    if (this.displays.length === 0) this.displays = await listDisplays();
    const primary = this.displays.find((d) => d.primary) ?? this.displays[0];
    return {
      displays: this.displays,
      orientation: primary && primary.width >= primary.height ? "landscape" : "portrait",
      width: primary?.width ?? 0,
      height: primary?.height ?? 0,
    };
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<Screenshot> {
    this.requireScreenshotCapability();
    if (this.displays.length === 0) this.displays = await listDisplays();
    const primary = this.displays.find((d) => d.primary) ?? this.displays[0];
    if (!primary) throw new ComputerUseError("unsupported", "No active display found");

    let region = options.region;
    if (options.windowId) {
      // windowId may carry an element path snapshot — use its bounds as ROI
      const el = this.lastTree.find((t) => t.path === options.windowId);
      if (el && el.x !== null && el.y !== null && el.width !== null && el.height !== null) {
        region = { x: el.x, y: el.y, width: el.width, height: el.height };
      }
    }
    if (options.displayId) {
      const d = this.displays.find((d) => d.id === options.displayId);
      if (d) region = { x: d.x, y: d.y, width: d.width, height: d.height };
    }

    const raw = await captureDisplay(region);
    const origin = region ? { x: region.x, y: region.y } : { x: primary.x, y: primary.y };
    return processScreenshot(raw, {
      targetId: this.info.id,
      scale: primary.scale,
      origin,
      orientation: primary.width >= primary.height ? "landscape" : "portrait",
    }, this.opts.screenshot);
  }

  async observe(options: ObserveOptions = {}): Promise<Observation> {
    const includeShot = options.includeScreenshot !== false;
    const includeTree = options.includeUITree !== false;
    const screen = await this.getScreenInfo();
    const activeApp = await this.frontmostApp();
    const shot = includeShot ? await this.screenshot().catch(() => undefined) : undefined;
    let uiTree;
    if (includeTree && this.caps.accessibility && activeApp?.name) {
      try {
        this.lastTree = await readAxTree({
          processName: activeApp.name,
          maxDepth: options.maxTreeDepth ?? this.opts.axTree?.maxDepth ?? 12,
          maxNodes: this.opts.axTree?.maxNodes ?? 200,
        });
        uiTree = axToTree(this.lastTree) ?? undefined;
      } catch {
        this.lastTree = [];
      }
    }
    return {
      target: this.info,
      screen,
      screenshot: shot,
      activeApp,
      uiTree,
      capabilities: this.caps,
      capturedAt: Date.now(),
    };
  }

  private async frontmostApp(): Promise<AppInfo | undefined> {
    try {
      const name = await osascript('tell application "System Events" to get name of first process whose frontmost is true', 10_000);
      return { name: name.trim(), frontmost: true };
    } catch {
      return undefined;
    }
  }

  async locate(descriptor: {
    role?: string;
    name?: string;
    text?: string;
    index?: number;
  }): Promise<{ element: ElementRef } | null> {
    if (!this.caps.accessibility) return null;
    const activeApp = await this.frontmostApp();
    if (!activeApp?.name) return null;
    if (this.lastTree.length === 0) {
      this.lastTree = await readAxTree({ processName: activeApp.name, maxDepth: 12, maxNodes: 200 });
    }
    const wantName = (descriptor.name ?? descriptor.text ?? "").toLowerCase();
    const wantRole = descriptor.role ? `ax${descriptor.role}`.replace(/^(ax)ax/, "ax") : null;
    const matches: AxElement[] = [];
    for (const el of this.lastTree) {
      if (wantRole && el.role.toLowerCase() !== wantRole!.toLowerCase() && el.role.toLowerCase() !== descriptor.role?.toLowerCase()) continue;
      const nameLower = el.name.toLowerCase();
      if (wantName && !nameLower.includes(wantName) && !wantName.includes(nameLower)) continue;
      if (!wantName && !wantRole) continue;
      matches.push(el);
    }
    const pick = matches[descriptor.index ?? 0];
    if (!pick) return null;
    return {
      element: {
        id: `ax:${pick.path}`,
        source: "ax",
        role: pick.role,
        name: pick.name,
        bounds:
          pick.x !== null && pick.y !== null && pick.width !== null && pick.height !== null
            ? { x: pick.x, y: pick.y, width: pick.width, height: pick.height }
            : undefined,
        clickable: INTERACTIVE_ROLES.has(pick.role),
        attributes: { process: activeApp.name, axPath: pick.path },
      },
    };
  }

  async executeAction(action: Action): Promise<ActionResult> {
    const started = Date.now();
    try {
      const result = await this.executeInner(action);
      return { ...result, durationMs: Date.now() - started };
    } catch (e) {
      const err = e instanceof ComputerUseError ? e : new ComputerUseError("internal_error", (e as Error).message, { cause: e });
      return {
        ok: false,
        method: "system",
        error: { code: err.code, message: err.message, hint: err.hint },
        durationMs: Date.now() - started,
      };
    }
  }

  private async executeInner(action: Action): Promise<Omit<ActionResult, "durationMs">> {
    switch (action.type) {
      case "click":
      case "double_click":
      case "right_click":
      case "long_press": {
        const el = "element" in action ? action.element : undefined;
        const resolved = el ? this.tryResolveElement(el) : undefined;
        // Semantic first (AXPress), coordinate fallback.
        if (el && resolved) {
          try {
            await axClick(resolved.processName, resolved.path);
            return { ok: true, method: "semantic", element: el };
          } catch {
            /* fall through to coordinate click */
          }
        }
        const pt = await this.requirePoint(action, el, resolved);
        if (action.type === "long_press") {
          await input.mouseDrag(pt, pt, action.durationMs ?? 800);
        } else {
          await input.mouseClick(pt.x, pt.y, action.type === "right_click" ? "right" : "left", action.type === "double_click" ? 2 : 1);
        }
        return { ok: true, method: resolved ? "semantic" : "coordinate", element: el, point: pt };
      }
      case "move": {
        const pt = this.pointFromAction(action.point);
        await input.mouseMove(pt.x, pt.y);
        return { ok: true, method: "coordinate", point: pt };
      }
      case "drag":
      case "swipe": {
        if (!action.from || !action.to) throw new ComputerUseError("invalid_request", `${action.type} requires from+to`);
        const from = await this.resolveEndpoint(action.from);
        const to = await this.resolveEndpoint(action.to);
        await input.mouseDrag(from, to, action.durationMs ?? 400);
        return { ok: true, method: "coordinate", point: to };
      }
      case "scroll": {
        const anchor = action.point ? this.pointFromAction(action.point) : { x: 960, y: 540 };
        await input.scroll(anchor.x, anchor.y, action.direction, action.amount ?? 3);
        return { ok: true, method: "coordinate", point: anchor };
      }
      case "type": {
        if (action.element) {
          const resolved = this.tryResolveElement(action.element);
          if (resolved) {
            try {
              await axSetValue(resolved.processName, resolved.path, action.text);
              if (action.submit) await input.pressKey("enter");
              return { ok: true, method: "semantic", element: action.element };
            } catch {
              /* fall through to keyboard typing */
            }
            const bounds = resolved.bounds;
            if (bounds) {
              await input.mouseClick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
            }
          }
        }
        await input.typeText(action.text);
        if (action.submit) await input.pressKey("enter");
        return { ok: true, method: action.element ? "semantic" : "coordinate" };
      }
      case "set_value": {
        const resolved = this.resolveElement(action.element);
        await axSetValue(resolved.processName, resolved.path, action.value);
        return { ok: true, method: "semantic", element: action.element };
      }
      case "clear": {
        if (action.element) {
          const resolved = this.tryResolveElement(action.element);
          if (resolved) {
            try {
              await axSetValue(resolved.processName, resolved.path, "");
              return { ok: true, method: "semantic", element: action.element };
            } catch {
              /* fall through */
            }
          }
        }
        await input.pressKey("a", ["command"]);
        await input.pressKey("delete");
        return { ok: true, method: "coordinate" };
      }
      case "press":
        await input.pressKey(action.key);
        return { ok: true, method: "coordinate" };
      case "hotkey": {
        const mods = action.keys.slice(0, -1);
        const key = action.keys[action.keys.length - 1]!;
        await input.pressKey(key, mods);
        return { ok: true, method: "coordinate" };
      }
      case "select": {
        const resolved = this.resolveElement(action.element);
        if (action.value !== undefined) {
          await axSetValue(resolved.processName, resolved.path, action.value);
          return { ok: true, method: "semantic", element: action.element };
        }
        await axClick(resolved.processName, resolved.path);
        return { ok: true, method: "semantic", element: action.element };
      }
      case "toggle": {
        const resolved = this.resolveElement(action.element);
        const attrs = await axGetAttributes(resolved.processName, resolved.path);
        if (action.value !== undefined && attrs.checked === action.value) {
          return { ok: true, method: "semantic", element: action.element, detail: "already in target state" };
        }
        await axClick(resolved.processName, resolved.path);
        return { ok: true, method: "semantic", element: action.element };
      }
      case "invoke": {
        const resolved = this.resolveElement(action.element);
        await axClick(resolved.processName, resolved.path);
        return { ok: true, method: "semantic", element: action.element };
      }
      case "focus": {
        await this.focusTarget({ app: action.app, windowTitle: action.windowTitle });
        return { ok: true, method: "system" };
      }
      case "launch_app":
        await this.launchApp(action.app);
        return { ok: true, method: "system" };
      case "terminate_app":
        await this.terminateApp(action.app);
        return { ok: true, method: "system" };
      case "back":
      case "home":
        throw new ComputerUseError("unsupported", `Action "${action.type}" is mobile-only`, {
          hint: "Desktop equivalents: hotkey cmd+w / cmd+h, or focus another app.",
        });
      case "wait":
        await new Promise((r) => setTimeout(r, action.durationMs));
        return { ok: true, method: "system" };
      case "finish":
      case "fail":
        return { ok: true, method: "system", detail: action.type };
      default:
        throw new ComputerUseError("invalid_request", `Unhandled action type`);
    }
  }

  /** Element refs produced by this adapter carry ax:<path> ids + process in attributes. */
  private resolveElement(el: { id: string; source: string; attributes?: Record<string, unknown> }): ResolvedElement {
    if (el.source !== "ax" && !el.id.startsWith("ax:")) {
      throw new ComputerUseError("invalid_request", `Element ${el.id} does not belong to the macOS adapter (source=${el.source})`);
    }
    const path = el.id.startsWith("ax:") ? el.id.slice(3) : el.id;
    const processName = (el.attributes?.process as string) ?? this.cachedProcess;
    if (!processName) {
      throw new ComputerUseError("element_not_found", `Element ${el.id} has no owning process recorded`);
    }
    return { path, processName };
  }

  /** Like resolveElement but returns null for foreign elements (fusion fallback). */
  private tryResolveElement(el: { id: string; source: string; attributes?: Record<string, unknown>; bounds?: { x: number; y: number; width: number; height: number } }): (ResolvedElement & { bounds?: { x: number; y: number; width: number; height: number } }) | null {
    try {
      const r = this.resolveElement(el);
      return { ...r, bounds: el.bounds };
    } catch {
      return null;
    }
  }

  private cachedProcess = "";

  private async requirePoint(
    action: Action,
    el: { id: string; source: string; attributes?: Record<string, unknown>; bounds?: { x: number; y: number; width: number; height: number } } | undefined,
    resolved: ResolvedElement | null | undefined,
  ): Promise<{ x: number; y: number }> {
    if ("point" in action && action.point) return this.pointFromAction(action.point);
    const bounds = resolved?.bounds ?? el?.bounds;
    if (bounds) return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    throw new ComputerUseError("invalid_request", "No usable element bounds or point for pointer action");
  }

  private async resolveEndpoint(t: { element?: unknown; point?: { x: number; y: number; space?: string } }): Promise<{ x: number; y: number }> {
    if (t.point) return this.pointFromAction(t.point);
    const el = t.element as { id: string; source: string; attributes?: Record<string, unknown>; bounds?: { x: number; y: number; width: number; height: number } } | undefined;
    if (el?.bounds) return { x: el.bounds.x + el.bounds.width / 2, y: el.bounds.y + el.bounds.height / 2 };
    if (el) {
      const resolved = this.resolveElement(el);
      if (resolved.bounds) return { x: resolved.bounds.x + resolved.bounds.width / 2, y: resolved.bounds.y + resolved.bounds.height / 2 };
    }
    throw new ComputerUseError("invalid_request", "drag/swipe endpoints need point or element with bounds");
  }

  /** Accept points in any declared space; macOS logical points are canonical here. */
  private pointFromAction(p: { x: number; y: number; space?: string }): { x: number; y: number } {
    const space = p.space ?? "logical";
    if (space === "logical" || space === "screenshot") return { x: p.x, y: p.y };
    if (space === "physical") {
      const scale = this.displays.find((d) => d.primary)?.scale ?? 1;
      return { x: p.x / scale, y: p.y / scale };
    }
    // normalized [0,1000] against main display
    const primary = this.displays.find((d) => d.primary) ?? this.displays[0];
    return { x: (p.x / 1000) * (primary?.width ?? 1), y: (p.y / 1000) * (primary?.height ?? 1) };
  }

  async listApps(): Promise<AppInfo[]> {
    const raw = await osascript('tell application "System Events" to get name of every process whose background only is false', 15_000);
    return raw.split(",").map((s) => ({ name: s.trim() })).filter((a) => a.name);
  }

  async listWindows(): Promise<WindowInfo[]> {
    const activeApp = await this.frontmostApp();
    if (!activeApp?.name) return [];
    const script = `
tell application "System Events"
  set out to ""
  repeat with w in windows of process "${activeApp.name}"
    set p to position of w
    set s to size of w
    set out to out & (name of w) & "|" & (item 1 of p) & "," & (item 2 of p) & "," & (item 1 of s) & "," & (item 2 of s) & linefeed
  end repeat
  return out
end tell`;
    const raw = await osascript(script, 15_000).catch(() => "");
    return raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l, i) => {
        const [title, geo] = l.split("|");
        const [x, y, w, h] = (geo ?? "").split(",").map(Number);
        return {
          id: `${activeApp.name}:win${i + 1}`,
          title: title ?? "",
          app: activeApp.name,
          bounds: { x: x ?? 0, y: y ?? 0, width: w ?? 0, height: h ?? 0 },
          focused: i === 0,
        };
      });
  }

  async launchApp(app: string, options: LaunchOptions = {}): Promise<void> {
    const args = ["-a", app, ...(options.args ?? [])];
    const { run } = await import("../exec.js");
    const r = await run("/usr/bin/open", args, 15_000);
    if (r.code !== 0) {
      throw new ComputerUseError("element_not_found", `Cannot launch app "${app}": ${r.stderr.trim()}`, {
        hint: "Use the app name as shown in /Applications (e.g. \"Calculator\", \"Google Chrome\").",
      });
    }
  }

  async terminateApp(app: string): Promise<void> {
    await osascript(`tell application "System Events" to tell process ${JSON.stringify(app)} to keystroke "q" using command down`, 10_000).catch(() => {});
    await osascript(`tell application ${JSON.stringify(app)} to quit`, 10_000).catch(() => {});
  }

  async focusTarget(options: { app?: string; windowTitle?: string }): Promise<void> {
    if (!options.app && !options.windowTitle) {
      throw new ComputerUseError("invalid_request", "focus requires app or windowTitle");
    }
    const proc = options.app ?? (await this.findProcessByWindowTitle(options.windowTitle!));
    if (!proc) throw new ComputerUseError("element_not_found", `No process owning window "${options.windowTitle}"`);
    await osascript(`tell application "System Events" to set frontmost of process ${JSON.stringify(proc)} to true`, 10_000);
    this.cachedProcess = proc;
    if (options.windowTitle) {
      await osascript(
        `tell application "System Events" to perform action "AXRaise" of (first window of process ${JSON.stringify(proc)} whose name contains ${JSON.stringify(options.windowTitle)})`,
        10_000,
      ).catch(() => {});
    }
  }

  private async findProcessByWindowTitle(title: string): Promise<string | null> {
    const raw = await osascript(
      `tell application "System Events" to get name of every process whose background only is false`,
      15_000,
    );
    for (const proc of raw.split(",").map((s) => s.trim())) {
      const found = await osascript(
        `tell application "System Events" to get (count of windows of process ${JSON.stringify(proc)} whose name contains ${JSON.stringify(title)})`,
        10_000,
      ).catch(() => "0");
      if (Number.parseInt(found, 10) > 0) return proc;
    }
    return null;
  }
}
