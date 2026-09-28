/**
 * Windows PlatformAdapter — UIA-semantic-first, SendInput/GDI fallback.
 *
 * Coordinate space: PHYSICAL screen pixels everywhere.
 *   - UIA BoundingRectangle: physical
 *   - screenshots (GDI CopyFromScreen in a DPI-aware PS session): physical
 *   - SendInput: physical (converted to normalized 0..65535 in input.ps1)
 * => Screenshot.scale = 1 and origin = virtual-screen origin (negative on
 * multi-monitor setups with left-placed displays). DisplayInfo.scale is the
 * OS DPI scale (GetDpiForSystem) and is informational.
 *
 * Honesty rules (spec §33/§34):
 *   - capabilities.probe() reflects what actually worked (UIA root read,
 *     tiny GDI capture, interactive-desktop detection, UAC integrity).
 *   - Every action verifies its effect where cheap (SetValue/Toggle read
 *     back; launches re-check the process; failed PS scripts map to typed
 *     ComputerUseError codes — never ok:true by assumption).
 *   - UAC integrity is surfaced in capabilities.notes: windows with HIGHER
 *     integrity (elevated/admin apps) are NOT automatable from this process.
 */
import type {
  AppInfo,
  Capabilities,
  ElementRef,
  Observation,
  ScreenInfo,
  Screenshot,
  TargetInfo,
  UINode,
  WindowInfo,
} from "../../core/types.js";
import type { Action, ActionResult } from "../../core/types-action.js";
import { ComputerUseError, unsupported } from "../../core/errors.js";
import { processScreenshot } from "../../screenshot/pipeline.js";
import type { ObserveOptions, PlatformAdapter, ScreenshotOptions, LaunchOptions } from "../adapter.js";
import type { AdapterRegistration } from "../router.js";
import { encodeArgs, parsePsJson, runPowerShell } from "./powershell.js";
import {
  buildUiForest,
  centerOf,
  elementToRef,
  locateInElements,
  normalizeRole,
  readUiTree,
  runUiaAction,
  type UiaActionResultJson,
  type UiaElementJson,
  type UiaScope,
} from "./ui-tree.js";
import * as input from "./input.js";
import {
  captureScreen,
  getForegroundWindow,
  getScreenInfo,
  listDisplays,
  probeCapture,
  type CaptureStats,
  type ForegroundWindowInfo,
  type WindowsScreenInfo,
} from "./screen.js";

export interface WindowsAdapterOptions {
  screenshot?: { format?: "png" | "jpeg"; jpegQuality?: number; maxDimension?: number };
  tree?: { maxDepth?: number; maxNodes?: number };
}

export interface WindowsSysInfo {
  ok: boolean;
  psVersion: string;
  clrVersion?: string;
  osVersion: string;
  is64Bit: boolean;
  integrity: { sid: string; label: string; elevated: boolean };
  mySessionId: number;
  explorerSessions: number[];
  interactiveDesktop: boolean;
  quser: string;
  computerName?: string;
}

interface WindowedProcess { pid: number; name: string; title: string }

interface AppsResultJson { ok: boolean; action: string; pid?: number; name?: string; killed?: number[]; exists?: boolean; pids?: number[] }

/** sysinfo.ps1 info mode — integrity level, session/desktop reality. */
export async function readSystemInfo(): Promise<WindowsSysInfo> {
  const r = await runPowerShell("sysinfo.ps1", ["-Mode", "info"], 25_000);
  return parsePsJson<WindowsSysInfo>("sysinfo.ps1", r);
}

/** sysinfo.ps1 procs mode — processes with a main window. */
export async function listWindowedProcesses(): Promise<WindowedProcess[]> {
  const r = await runPowerShell("sysinfo.ps1", ["-Mode", "procs"], 25_000);
  return parsePsJson<WindowedProcess[]>("sysinfo.ps1", r);
}

async function runApps(action: "launch" | "kill" | "exists", payload: Record<string, unknown>): Promise<AppsResultJson> {
  const r = await runPowerShell("apps.ps1", ["-Action", action, "-ArgsJson", encodeArgs(payload)], 30_000);
  return parsePsJson<AppsResultJson>("apps.ps1", r);
}

function scopeAttrs(scope: UiaScope): Record<string, string | number | boolean | null> {
  if (scope.pid !== undefined) return { scopePid: scope.pid };
  if (scope.windowTitle !== undefined) return { scopeTitle: scope.windowTitle };
  if (scope.processName !== undefined) return { scopeProcess: scope.processName };
  return { scopeDesktop: true };
}

function scopeFromAttributes(el: { id: string; attributes?: Record<string, unknown> }): UiaScope {
  const a = el.attributes ?? {};
  if (typeof a.scopePid === "number" && a.scopePid > 0) return { pid: a.scopePid };
  if (typeof a.scopeProcess === "string" && a.scopeProcess) return { processName: a.scopeProcess };
  if (typeof a.scopeTitle === "string" && a.scopeTitle) return { windowTitle: a.scopeTitle };
  if (a.scopeDesktop === true) return { desktopRoot: true };
  if (typeof a.pid === "number" && a.pid > 0) return { pid: a.pid };
  return { desktopRoot: true };
}

/** Await a UIA call that is allowed to fail; returns result or the error. */
async function tryUia(req: Parameters<typeof runUiaAction>[0], timeoutMs = 15_000): Promise<UiaActionResultJson | ComputerUseError> {
  return runUiaAction(req, timeoutMs).catch((e: unknown): ComputerUseError =>
    e instanceof ComputerUseError ? e : new ComputerUseError("internal_error", (e as Error).message, { cause: e }));
}

export class WindowsAdapter implements PlatformAdapter {
  readonly platform = "windows";
  private info!: TargetInfo;
  private caps!: Capabilities;
  private sys!: WindowsSysInfo;
  private screen: WindowsScreenInfo | null = null;
  private displays: Awaited<ReturnType<typeof listDisplays>> = [];
  private lastTree: UiaElementJson[] = [];
  private lastTreeScope: UiaScope = { desktopRoot: true };
  private lastCaptureStats: CaptureStats | null = null;

  constructor(private readonly opts: WindowsAdapterOptions = {}) {}

  async open(): Promise<TargetInfo> {
    if (process.platform !== "win32") {
      throw unsupported("windows adapter", `requires win32, got ${process.platform}`);
    }

    this.sys = await readSystemInfo();
    this.screen = await getScreenInfo().catch(() => null);
    this.displays = this.screen ? await listDisplays(this.screen) : [];

    const capture = await probeCapture();
    const accessibility = await this.probeUia();

    const notes: string[] = [];
    const integrityLabel = this.sys.integrity.label;
    notes.push(
      `UAC integrity level: ${integrityLabel} (${this.sys.integrity.sid || "unknown"}). ` +
        "Windows running at HIGHER integrity (apps started with 'Run as administrator') are NOT automatable from this process — UIA sees nothing and UIPI blocks input. Run the MCP elevated to automate elevated apps.",
    );
    if (!this.sys.interactiveDesktop) {
      notes.push(
        `No interactive desktop in this session (session id ${this.sys.mySessionId}, explorer sessions: ${JSON.stringify(this.sys.explorerSessions)}). ` +
          "SendInput injects into THIS session only and CopyFromScreen captures THIS session's (empty) desktop — the interactive console session's UI cannot be driven from SSH/service contexts.",
      );
    }
    notes.push(
      "Coordinates are physical screen pixels (DPI-aware session): UIA bounds, screenshots and SendInput agree; Screenshot.scale=1. DisplayInfo.scale is the OS DPI scale, informational only.",
    );
    notes.push(
      "A successful CopyFromScreen does not guarantee real content — a locked/disconnected session yields a valid but black PNG (check the observation hash/stats).",
    );

    this.caps = {
      screenshot: capture,
      accessibility,
      dom: false,
      globalInput: this.sys.interactiveDesktop,
      windowControl: accessibility,
      appControl: true,
      clipboard: true,
      multiDisplay: (this.screen?.displays.length ?? 0) > 1,
      notes,
    };

    const primary = this.screen?.displays.find((d) => d.primary);
    this.info = {
      id: "local:windows",
      platform: "windows",
      type: "local",
      name: `Local Windows (${primary?.width ?? "?"}x${primary?.height ?? "?"}, DPI ${this.screen?.dpi ?? "?"}, integrity ${integrityLabel}${this.sys.interactiveDesktop ? "" : ", no interactive desktop"})`,
      details: {
        computer: this.sys.computerName,
        os: this.sys.osVersion,
        powershell: this.sys.psVersion,
        integrity: integrityLabel,
        integritySid: this.sys.integrity.sid,
        elevated: this.sys.integrity.elevated,
        interactiveDesktop: this.sys.interactiveDesktop,
        sessionId: this.sys.mySessionId,
        displays: this.screen?.displays.length ?? 0,
        uia: accessibility,
        capture,
      },
    };
    return this.info;
  }

  /** UIA probe: reading the desktop root's children must not throw. */
  private async probeUia(): Promise<boolean> {
    try {
      await readUiTree({ desktopRoot: true, maxDepth: 1, maxNodes: 30 });
      return true;
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

  private async requireInteractiveDesktop(what: string): Promise<void> {
    if (this.caps?.globalInput) return;
    throw new ComputerUseError("permission_required", `${what}: no interactive desktop in this session`, {
      details: { sessionId: this.sys?.mySessionId, explorerSessions: this.sys?.explorerSessions },
      hint: "Run the MCP inside the interactive console session, not via SSH/service. Input cannot cross sessions on Windows.",
    });
  }

  async getScreenInfo(): Promise<ScreenInfo> {
    if (!this.screen) this.screen = await getScreenInfo().catch(() => null);
    if (!this.screen) throw new ComputerUseError("internal_error", "screen.ps1 info failed");
    this.displays = await listDisplays(this.screen);
    const primary = this.displays.find((d) => d.primary) ?? this.displays[0];
    return {
      displays: this.displays,
      orientation: primary && primary.width >= primary.height ? "landscape" : "portrait",
      width: primary?.width ?? 0,
      height: primary?.height ?? 0,
    };
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<Screenshot> {
    if (!this.caps?.screenshot) {
      throw new ComputerUseError("permission_required", "Screen capture is not available in this session", {
        hint: "CopyFromScreen needs a desktop in the CALLING session. Over SSH/service there is none — run inside the interactive session.",
      });
    }
    let region = options.region;
    if (options.windowId) {
      // windowId may carry a uia:<runtimeId> of a window element — resolve bounds
      const rid = options.windowId.replace(/^uia:/, "");
      const res = await tryUia({ runtimeId: rid, action: "readBounds", ...this.lastTreeScope }, 15_000);
      if (!(res instanceof ComputerUseError) && res.bounds) region = res.bounds;
    }

    const capture = await captureScreen({ region, displayId: options.displayId });
    this.lastCaptureStats = capture.stats;

    const origin = capture.stats.origin;
    return processScreenshot(
      capture.png,
      {
        targetId: this.info.id,
        scale: 1,
        origin: { x: origin.x, y: origin.y },
        orientation: capture.stats.width >= capture.stats.height ? "landscape" : "portrait",
      },
      this.opts.screenshot,
    );
  }

  async observe(options: ObserveOptions = {}): Promise<Observation> {
    const screen = await this.getScreenInfo();
    const fg = await getForegroundWindow(this.screen ?? undefined).catch(() => null);
    const shot = options.includeScreenshot !== false ? await this.screenshot().catch(() => undefined) : undefined;

    let uiTree: UINode | undefined;
    if (options.includeUITree !== false && this.caps.accessibility) {
      const scope: UiaScope = fg?.pid ? { pid: fg.pid } : { desktopRoot: true };
      try {
        this.lastTree = await readUiTree({
          ...scope,
          maxDepth: options.maxTreeDepth ?? this.opts.tree?.maxDepth ?? 14,
          maxNodes: this.opts.tree?.maxNodes ?? 600,
        });
        this.lastTreeScope = scope;
        const forest = buildUiForest(this.lastTree).map((n) => this.decorateNode(n, scope));
        if (forest.length === 1) uiTree = forest[0];
        else if (forest.length > 1) {
          uiTree = { id: "uia:desktop", source: "uia", role: "desktop", children: forest };
        }
      } catch {
        this.lastTree = [];
      }
    }

    const windowed = await listWindowedProcesses().catch(() => [] as WindowedProcess[]);
    const activeApp: AppInfo | undefined = fg
      ? { name: fg.process || `pid ${fg.pid}`, pid: fg.pid, context: fg.title || undefined, frontmost: true }
      : undefined;

    return {
      target: this.info,
      screen,
      screenshot: shot,
      activeApp,
      uiTree,
      windows: this.windowsFromElements(this.lastTree, windowed, fg),
      capabilities: this.caps,
      capturedAt: Date.now(),
    };
  }

  private decorateNode(node: UINode, scope: UiaScope): UINode {
    const out: UINode = {
      ...node,
      attributes: { ...(node.attributes ?? {}), ...scopeAttrs(scope) },
    };
    if (node.children) out.children = node.children.map((c) => this.decorateNode(c, scope));
    return out;
  }

  private windowsFromElements(
    elements: UiaElementJson[],
    procs: WindowedProcess[],
    fg: Pick<ForegroundWindowInfo, "pid" | "title"> | null,
  ): WindowInfo[] {
    const nameByPid = new Map<number, string>();
    for (const p of procs) nameByPid.set(p.pid, p.name);
    return elements
      .filter((el) => normalizeRole(el.role) === "window" && el.depth <= 1 && el.bounds !== null)
      .map((el) => ({
        id: `uia:${el.runtimeId}`,
        title: el.name || nameByPid.get(el.pid ?? -1) || "",
        app: el.pid !== undefined ? nameByPid.get(el.pid) : undefined,
        bounds: el.bounds ?? undefined,
        focused: Boolean(fg && el.pid === fg.pid && (el.name || "") === (fg.title ?? "")),
      }));
  }

  async locate(descriptor: {
    role?: string;
    name?: string;
    text?: string;
    resourceId?: string;
    index?: number;
  }): Promise<{ element: ElementRef } | null> {
    if (!this.caps?.accessibility) return null;
    if (this.lastTree.length === 0) {
      const fg = await getForegroundWindow(this.screen ?? undefined).catch(() => null);
      const scope: UiaScope = fg?.pid ? { pid: fg.pid } : { desktopRoot: true };
      this.lastTree = await readUiTree({ ...scope, maxNodes: 600 }).catch(() => [] as UiaElementJson[]);
      this.lastTreeScope = scope;
    }
    const el = locateInElements(this.lastTree, descriptor);
    if (!el) return null;
    const ref = elementToRef(el);
    return { element: { ...ref, attributes: { ...(ref.attributes ?? {}), ...scopeAttrs(this.lastTreeScope) } } };
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

  /** RuntimeId + owning scope of an adapter-produced element. */
  private resolveUiaElement(el: { id: string; source?: string; attributes?: Record<string, unknown> }): { runtimeId: string; scope: UiaScope } {
    if (el.source && el.source !== "uia" && !el.id.startsWith("uia:")) {
      throw new ComputerUseError("invalid_request", `Element ${el.id} does not belong to the Windows adapter (source=${el.source})`);
    }
    if (!el.id.startsWith("uia:")) {
      throw new ComputerUseError("invalid_request", `Element ${el.id} has no UIA RuntimeId`, {
        hint: "Use elements from observe()/locate() of this adapter, or fall back to point coordinates.",
      });
    }
    return { runtimeId: el.id.slice(4), scope: scopeFromAttributes(el) };
  }

  private pointFromAction(p: { x: number; y: number; space?: string }): { x: number; y: number } {
    const space = p.space ?? "screenshot";
    if (space === "physical" || space === "screenshot") return { x: p.x, y: p.y };
    if (space === "logical") {
      const scale = this.screen && this.screen.scale > 0 ? this.screen.scale : 1;
      return { x: p.x * scale, y: p.y * scale };
    }
    // normalized [0,1000] over the virtual screen
    const vs = this.screen?.virtualScreen ?? { x: 0, y: 0, width: 1, height: 1 };
    return {
      x: vs.x + (p.x / 1000) * vs.width,
      y: vs.y + (p.y / 1000) * vs.height,
    };
  }

  private elementCenter(el?: { bounds?: { x: number; y: number; width: number; height: number } }): { x: number; y: number } | null {
    if (el?.bounds && el.bounds.width > 0 && el.bounds.height > 0) return centerOf(el.bounds);
    return null;
  }

  private async endpoint(
    t: { element?: ElementRef; point?: { x: number; y: number; space?: string } } | undefined,
    what: string,
  ): Promise<{ x: number; y: number }> {
    if (!t) throw new ComputerUseError("invalid_request", `${what} requires a point or an element with bounds`);
    if (t.point) return this.pointFromAction(t.point);
    if (t.element) {
      const c = this.elementCenter(t.element);
      if (c) return c;
      const { runtimeId, scope } = this.resolveUiaElement(t.element);
      const res = await tryUia({ runtimeId, action: "readBounds", ...scope });
      if (!(res instanceof ComputerUseError) && res.bounds) return centerOf(res.bounds);
    }
    throw new ComputerUseError("invalid_request", `${what}: no usable point or element bounds`);
  }

  private async executeInner(action: Action): Promise<Omit<ActionResult, "durationMs">> {
    switch (action.type) {
      case "click":
      case "double_click":
      case "right_click":
      case "long_press": {
        const el = "element" in action ? action.element : undefined;
        // Semantic first: UIA Invoke (single left click only).
        if (el && action.type === "click" && action.button !== "right" && el.source === "uia") {
          const { runtimeId, scope } = this.resolveUiaElement(el);
          const res = await tryUia({ runtimeId, action: "invoke", ...scope });
          if (res instanceof ComputerUseError) {
            if (res.code !== "unsupported") throw res; // element vanished / blocked — honest failure
          } else {
            return { ok: true, method: "semantic", element: el, detail: "UIA InvokePattern.Invoke" };
          }
        }
        let pt: { x: number; y: number };
        if ("point" in action && action.point) {
          pt = this.pointFromAction(action.point);
        } else {
          const center = this.elementCenter(el);
          if (center) {
            pt = center;
          } else if (el && el.source === "uia") {
            const { runtimeId, scope } = this.resolveUiaElement(el);
            const res = await tryUia({ runtimeId, action: "readBounds", ...scope });
            if (res instanceof ComputerUseError || !res.bounds) {
              throw new ComputerUseError("invalid_request", "Element has no bounds and no point was given");
            }
            pt = centerOf(res.bounds);
          } else {
            throw new ComputerUseError("invalid_request", `${action.type} needs element bounds or a point`);
          }
        }
        await this.requireInteractiveDesktop("pointer input");
        if (action.type === "long_press") {
          await input.mouseDrag(pt, pt, action.durationMs ?? 800);
        } else {
          await input.mouseClick(pt.x, pt.y, action.type === "right_click" ? "right" : "left", action.type === "double_click" ? 2 : 1);
        }
        return { ok: true, method: "coordinate", element: el, point: pt, detail: "SendInput" };
      }

      case "move": {
        await this.requireInteractiveDesktop("pointer input");
        const pt = this.pointFromAction(action.point);
        await input.mouseMove(pt.x, pt.y);
        return { ok: true, method: "coordinate", point: pt };
      }

      case "drag":
      case "swipe": {
        await this.requireInteractiveDesktop("pointer input");
        const from = await this.endpoint(action.from, action.type);
        const to = await this.endpoint(action.to, action.type);
        await input.mouseDrag(from, to, action.durationMs ?? 400);
        return { ok: true, method: "coordinate", point: to, detail: "SendInput drag" };
      }

      case "scroll": {
        await this.requireInteractiveDesktop("pointer input");
        let anchor: { x: number; y: number };
        if (action.point) anchor = this.pointFromAction(action.point);
        else {
          const c = this.elementCenter(action.element);
          anchor = c ?? this.virtualScreenCenter();
        }
        await input.mouseScroll(anchor.x, anchor.y, action.direction, action.amount ?? 3);
        return { ok: true, method: "coordinate", point: anchor };
      }

      case "type": {
        if (action.element && action.element.source === "uia") {
          const { runtimeId, scope } = this.resolveUiaElement(action.element);
          const res = await tryUia({ runtimeId, action: "setValue", value: action.text, ...scope });
          if (res instanceof ComputerUseError) {
            if (res.code !== "unsupported") throw res;
            // fallback: focus (UIA SetFocus, else click center) + real typing
            const focus = await tryUia({ runtimeId, action: "setFocus", ...scope }, 10_000);
            if (focus instanceof ComputerUseError) {
              const c = this.elementCenter(action.element);
              if (c) {
                await this.requireInteractiveDesktop("pointer input");
                await input.mouseClick(c.x, c.y);
              }
            }
          } else {
            if (action.submit) await this.pressEnterSafely();
            return { ok: true, method: "semantic", element: action.element, detail: "UIA ValuePattern.SetValue (verified read-back)" };
          }
        }
        await this.requireInteractiveDesktop("keyboard input");
        await input.typeText(action.text);
        if (action.submit) await this.pressEnterSafely();
        return { ok: true, method: "coordinate", element: action.element, detail: "SendInput KEYEVENTF_UNICODE" };
      }

      case "set_value": {
        const { runtimeId, scope } = this.resolveUiaElement(action.element);
        const res = await runUiaAction({ runtimeId, action: "setValue", value: action.value, ...scope }, 15_000);
        return { ok: true, method: "semantic", element: action.element, detail: `UIA ValuePattern.SetValue, read-back: "${res.valueAfter ?? ""}"` };
      }

      case "clear": {
        if (action.element && action.element.source === "uia") {
          const { runtimeId, scope } = this.resolveUiaElement(action.element);
          const res = await tryUia({ runtimeId, action: "setValue", value: "", ...scope });
          if (!(res instanceof ComputerUseError)) {
            return { ok: true, method: "semantic", element: action.element, detail: `cleared via ValuePattern (read-back: "${res.valueAfter ?? ""}")` };
          }
          /* fall through to keyboard clearing */
        }
        await this.requireInteractiveDesktop("keyboard input");
        await input.pressKey("a", ["ctrl"]);
        await input.pressKey("delete");
        return { ok: true, method: "coordinate", element: action.element };
      }

      case "press": {
        await this.requireInteractiveDesktop("keyboard input");
        await input.pressKey(action.key);
        return { ok: true, method: "coordinate", detail: `SendInput ${action.key}` };
      }

      case "hotkey": {
        await this.requireInteractiveDesktop("keyboard input");
        const mods = action.keys.slice(0, -1);
        const key = action.keys[action.keys.length - 1]!;
        await input.pressKey(key, mods);
        return { ok: true, method: "coordinate", detail: `SendInput ${action.keys.join("+")}` };
      }

      case "select": {
        const { runtimeId, scope } = this.resolveUiaElement(action.element);
        if (action.value !== undefined) {
          const res = await tryUia({ runtimeId, action: "setValue", value: action.value, ...scope });
          if (res instanceof ComputerUseError) {
            if (res.code !== "unsupported") throw res;
          } else {
            return { ok: true, method: "semantic", element: action.element, detail: "UIA ValuePattern.SetValue" };
          }
        }
        const sel = await tryUia({ runtimeId, action: "select", ...scope });
        if (sel instanceof ComputerUseError) {
          if (sel.code !== "unsupported") throw sel;
          // coordinate fallback: click the element
          const c = this.elementCenter(action.element);
          if (c) {
            await this.requireInteractiveDesktop("pointer input");
            await input.mouseClick(c.x, c.y);
            return { ok: true, method: "coordinate", element: action.element, point: c };
          }
          throw sel;
        }
        return { ok: true, method: "semantic", element: action.element, detail: "UIA SelectionItemPattern.Select" };
      }

      case "toggle": {
        const { runtimeId, scope } = this.resolveUiaElement(action.element);
        const res = await tryUia({ runtimeId, action: "toggle", toggleValue: action.value, ...scope });
        if (res instanceof ComputerUseError) {
          if (res.code !== "unsupported") throw res;
          const c = this.elementCenter(action.element);
          if (c) {
            await this.requireInteractiveDesktop("pointer input");
            await input.mouseClick(c.x, c.y);
            return { ok: true, method: "coordinate", element: action.element, point: c, detail: "toggle via SendInput click (no Toggle pattern)" };
          }
          throw res;
        }
        return {
          ok: true,
          method: "semantic",
          element: action.element,
          detail: res.unchanged
            ? `already ${res.toggleState}`
            : `UIA TogglePattern: ${res.toggleBefore ?? "?"} -> ${res.toggleAfter ?? res.toggleState ?? "?"}`,
        };
      }

      case "invoke": {
        const { runtimeId, scope } = this.resolveUiaElement(action.element);
        const res = await tryUia({ runtimeId, action: "invoke", ...scope });
        if (res instanceof ComputerUseError) {
          if (res.code !== "unsupported") throw res;
          const c = this.elementCenter(action.element);
          if (c) {
            await this.requireInteractiveDesktop("pointer input");
            await input.mouseClick(c.x, c.y);
            return { ok: true, method: "coordinate", element: action.element, point: c, detail: "invoke via SendInput click (no Invoke pattern)" };
          }
          throw res;
        }
        return { ok: true, method: "semantic", element: action.element, detail: "UIA InvokePattern.Invoke" };
      }

      case "focus": {
        await this.focusTarget({ app: action.app, windowTitle: action.windowTitle });
        return { ok: true, method: "system" };
      }

      case "launch_app": {
        await this.launchApp(action.app);
        return { ok: true, method: "system", detail: `Start-Process ${action.app}` };
      }

      case "terminate_app": {
        const res = await runApps("kill", { name: action.app }).catch((e: unknown): ComputerUseError =>
          e instanceof ComputerUseError ? e : new ComputerUseError("internal_error", (e as Error).message, { cause: e }));
        if (res instanceof ComputerUseError) throw res;
        return { ok: true, method: "system", detail: `stopped pids ${JSON.stringify(res.killed ?? [])}` };
      }

      case "back":
      case "home":
        throw new ComputerUseError("unsupported", `Action "${action.type}" is mobile-only`, {
          hint: "Desktop equivalents: hotkey alt+f4 / win+d, or focus another app.",
        });

      case "wait":
        await new Promise((r) => setTimeout(r, action.durationMs));
        return { ok: true, method: "system" };

      case "finish":
      case "fail":
        return { ok: true, method: "system", detail: action.type };

      default:
        throw new ComputerUseError("invalid_request", "Unhandled action type");
    }
  }

  private virtualScreenCenter(): { x: number; y: number } {
    const vs = this.screen?.virtualScreen;
    if (vs) return { x: Math.round(vs.x + vs.width / 2), y: Math.round(vs.y + vs.height / 2) };
    return { x: 0, y: 0 };
  }

  private async pressEnterSafely(): Promise<void> {
    await input.pressKey("enter").catch(() => {});
  }

  async listApps(): Promise<AppInfo[]> {
    const [procs, fg] = await Promise.all([
      listWindowedProcesses().catch(() => [] as WindowedProcess[]),
      getForegroundWindow(this.screen ?? undefined).catch(() => null),
    ]);
    return procs.map((p) => ({
      name: p.name,
      pid: p.pid,
      context: p.title || undefined,
      frontmost: Boolean(fg && fg.pid === p.pid),
    }));
  }

  async listWindows(): Promise<WindowInfo[]> {
    const [elements, procs, fg] = await Promise.all([
      readUiTree({ desktopRoot: true, maxDepth: 1, maxNodes: 200 }).catch(() => [] as UiaElementJson[]),
      listWindowedProcesses().catch(() => [] as WindowedProcess[]),
      getForegroundWindow(this.screen ?? undefined).catch(() => null),
    ]);
    return this.windowsFromElements(elements, procs, fg);
  }

  async launchApp(app: string, options: LaunchOptions = {}): Promise<void> {
    const res = await runApps("launch", { app, args: options.args }).catch((e: unknown): ComputerUseError =>
      e instanceof ComputerUseError ? e : new ComputerUseError("internal_error", (e as Error).message, { cause: e }));
    if (res instanceof ComputerUseError) throw res;
    if (typeof res.pid !== "number") {
      throw new ComputerUseError("element_not_found", `launch "${app}": no pid returned`);
    }
    // cheap verification: the process must still exist right after start
    await new Promise((resolve) => setTimeout(resolve, 400));
    const check = await runApps("exists", { pid: res.pid }).catch(() => null);
    if (!check?.exists) {
      throw new ComputerUseError("element_not_found", `launch "${app}": process ${res.pid} exited immediately`, {
        hint: "Check the executable name/path.",
      });
    }
  }

  async terminateApp(app: string): Promise<void> {
    await runApps("kill", { name: app }).catch((e: unknown): ComputerUseError =>
      e instanceof ComputerUseError ? e : new ComputerUseError("internal_error", (e as Error).message, { cause: e }));
  }

  async focusTarget(options: { app?: string; windowTitle?: string }): Promise<void> {
    if (!options.app && !options.windowTitle) {
      throw new ComputerUseError("invalid_request", "focus requires app or windowTitle");
    }
    // Find a top-level window by pid-of-app or title substring, then UIA SetFocus.
    const elements = await readUiTree({ desktopRoot: true, maxDepth: 1, maxNodes: 200 });
    let targetPid: number | undefined;
    if (options.app) {
      const procs = await listWindowedProcesses().catch(() => [] as WindowedProcess[]);
      targetPid = procs.find((p) => p.name.toLowerCase() === options.app!.toLowerCase())?.pid;
      if (targetPid === undefined) {
        throw new ComputerUseError("element_not_found", `no windowed process named "${options.app}"`);
      }
    }
    const win = elements.find((el) => {
      if (normalizeRole(el.role) !== "window") return false;
      if (targetPid !== undefined && el.pid !== targetPid) return false;
      if (options.windowTitle && !el.name.toLowerCase().includes(options.windowTitle.toLowerCase())) return false;
      return true;
    });
    if (!win) {
      throw new ComputerUseError("element_not_found", `no matching window (app=${options.app ?? "-"}, title=${options.windowTitle ?? "-"})`);
    }
    await runUiaAction({ runtimeId: win.runtimeId, action: "setFocus", desktopRoot: true }, 10_000);
    // honest verification: is the foreground window now the target's?
    await new Promise((r) => setTimeout(r, 250));
    const fg = await getForegroundWindow(this.screen ?? undefined).catch(() => null);
    const matched = options.app
      ? fg !== null && (fg.process.toLowerCase() === options.app.toLowerCase() || fg.pid === win.pid)
      : fg !== null && (fg.title || "").toLowerCase().includes(options.windowTitle!.toLowerCase());
    if (!matched) {
      throw new ComputerUseError("restricted", `Windows did not grant foreground to "${options.app ?? options.windowTitle}" (foreground: ${fg ? `${fg.process} "${fg.title}"` : "none"})`, {
        hint: "Windows restricts SetForegroundWindow for background callers; the target window usually still flashes in the taskbar. Retry or focus interactively once.",
      });
    }
  }
}

/** Router registration for the Windows adapter (spec §15). */
export function createWindowsRegistration(): AdapterRegistration {
  return {
    platform: "windows",
    factory: async () => new WindowsAdapter(),
    probe: async () => {
      if (process.platform !== "win32") {
        return { available: false, reason: `requires win32, got ${process.platform}` };
      }
      try {
        const sys = await readSystemInfo();
        return {
          available: true,
          details: {
            integrity: sys.integrity.label,
            interactiveDesktop: sys.interactiveDesktop,
            os: sys.osVersion,
            powershell: sys.psVersion,
          },
        };
      } catch (e) {
        return { available: false, reason: (e as Error).message };
      }
    },
  };
}
