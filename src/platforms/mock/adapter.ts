/**
 * Deterministic in-memory adapter for tests, demos and CI.
 * Renders a virtual app UI ("mockapp") as a synthetic PNG so vision
 * providers and the whole delegate pipeline can run hermetically.
 */
import { PNG } from "pngjs";
import {
  type Capabilities,
  type AppInfo,
  type Observation,
  type ScreenInfo,
  type Screenshot,
  type TargetInfo,
  type UINode,
  type WindowInfo,
  type ElementRef,
  type Platform,
} from "../../core/types.js";
import type { Action, ActionResult } from "../../core/types-action.js";
import { ComputerUseError } from "../../core/errors.js";
import { averageHash, encodePng } from "../../screenshot/pipeline.js";
import type { ObserveOptions, PlatformAdapter, ScreenshotOptions, LaunchOptions } from "../adapter.js";

export interface MockElementSpec {
  id: string;
  role: string;
  name: string;
  value?: string;
  rect: { x: number; y: number; width: number; height: number };
  onActivate?: { setValue?: string; toggle?: boolean; log?: string };
}

export interface MockAppState {
  appName: string;
  elements: MockElementSpec[];
  eventLog: string[];
}

export function createDefaultMockState(): MockAppState {
  return {
    appName: "mockapp",
    eventLog: [],
    elements: [
      { id: "btn-settings", role: "button", name: "设置", rect: { x: 40, y: 40, width: 160, height: 48 } },
      { id: "btn-close", role: "button", name: "关闭按钮", rect: { x: 640, y: 40, width: 120, height: 40 } },
      { id: "chk-autoupdate", role: "checkbox", name: "自动更新", value: "on", rect: { x: 40, y: 140, width: 220, height: 32 } },
      { id: "input-search", role: "textfield", name: "搜索", value: "", rect: { x: 40, y: 220, width: 400, height: 40 } },
      { id: "btn-save", role: "button", name: "保存", rect: { x: 40, y: 320, width: 120, height: 48 } },
    ],
  };
}

function renderScreen(state: MockAppState): Buffer {
  const W = 800;
  const H = 600;
  const png = new PNG({ width: W, height: H });
  for (let i = 0; i < W * H; i++) {
    png.data[i * 4] = 24;
    png.data[i * 4 + 1] = 26;
    png.data[i * 4 + 2] = 32;
    png.data[i * 4 + 3] = 255;
  }
  for (const el of state.elements) {
    const checked = el.value === "on";
    const color: [number, number, number] =
      el.role === "button" ? [58, 110, 220] : el.role === "checkbox" ? (checked ? [46, 160, 80] : [90, 90, 96]) : [50, 54, 64];
    for (let y = el.rect.y; y < el.rect.y + el.rect.height; y++) {
      for (let x = el.rect.x; x < el.rect.x + el.rect.width; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = (y * W + x) * 4;
        png.data[i] = color[0];
        png.data[i + 1] = color[1];
        png.data[i + 2] = color[2];
        png.data[i + 3] = 255;
      }
    }
  }
  return PNG.sync.write(png);
}

export class MockAdapter implements PlatformAdapter {
  readonly platform = "mock";
  state: MockAppState;
  actionCount = 0;
  /** When true, semantic operations throw — used to test vision fallback. */
  structuredDisabled = false;
  private info: TargetInfo;
  private caps: Capabilities;
  private lastScreenshot: Screenshot | null = null;

  constructor(state: MockAppState = createDefaultMockState()) {
    this.state = state;
    this.info = {
      id: "mock:local",
      // "mock" is not a real platform; cast keeps the public Target schema clean.
      platform: "mock" as unknown as Platform,
      type: "local",
      name: "Mock deterministic target",
    };
    this.caps = {
      screenshot: true,
      accessibility: true,
      dom: false,
      globalInput: true,
      windowControl: true,
      appControl: true,
      clipboard: true,
      multiDisplay: false,
    };
  }

  async open(): Promise<TargetInfo> {
    return this.info;
  }

  async close(): Promise<void> {}

  getTargetInfo(): TargetInfo {
    return this.info;
  }

  getCapabilities(): Capabilities {
    return this.caps;
  }

  private assertStructured(): void {
    if (this.structuredDisabled) {
      throw new ComputerUseError("restricted", "mock: structured access disabled (vision-fallback test mode)");
    }
  }

  async observe(options: ObserveOptions = {}): Promise<Observation> {
    const screen: ScreenInfo = {
      displays: [{ id: "0", x: 0, y: 0, width: 800, height: 600, scale: 1, primary: true }],
      orientation: "landscape",
      width: 800,
      height: 600,
    };
    const shot = options.includeScreenshot === false ? undefined : await this.screenshot();
    let uiTree: UINode | undefined;
    if (options.includeUITree !== false && !this.structuredDisabled) {
      uiTree = {
        id: "mock:root",
        source: "uia",
        role: "window",
        name: this.state.appName,
        children: this.state.elements.map((el) => ({
          id: `mock:${el.id}`,
          source: "uia" as const,
          role: el.role,
          name: el.name,
          value: el.value,
          bounds: el.rect,
          clickable: true,
          editable: el.role === "textfield",
          attributes: { process: this.state.appName },
        })),
      };
    }
    return {
      target: this.info,
      screen,
      screenshot: shot,
      activeApp: { name: this.state.appName, frontmost: true },
      uiTree,
      capabilities: this.caps,
      capturedAt: Date.now(),
    };
  }

  async screenshot(_options?: ScreenshotOptions): Promise<Screenshot> {
    const raw = renderScreen(this.state);
    const decoded = PNG.sync.read(raw);
    const hash = averageHash({ width: decoded.width, height: decoded.height, data: Buffer.from(decoded.data) });
    this.lastScreenshot = {
      format: "png",
      dataBase64: raw.toString("base64"),
      width: 800,
      height: 600,
      scale: 1,
      origin: { x: 0, y: 0 },
      orientation: "landscape",
      hash,
      capturedAt: Date.now(),
      targetId: this.info.id,
    };
    return this.lastScreenshot;
  }

  async locate(descriptor: { role?: string; name?: string; text?: string; index?: number }): Promise<{ element: ElementRef } | null> {
    this.assertStructured();
    const name = (descriptor.name ?? descriptor.text ?? "").toLowerCase();
    const matches = this.state.elements.filter(
      (el) => (!name || el.name.toLowerCase().includes(name)) && (!descriptor.role || el.role === descriptor.role),
    );
    const pick = matches[descriptor.index ?? 0];
    if (!pick) return null;
    return {
      element: {
        id: `mock:${pick.id}`,
        source: "uia",
        role: pick.role,
        name: pick.name,
        value: pick.value,
        bounds: pick.rect,
        clickable: true,
        editable: pick.role === "textfield",
        attributes: { process: this.state.appName },
      },
    };
  }

  async executeAction(action: Action): Promise<ActionResult> {
    const started = Date.now();
    this.actionCount++;
    try {
      const result = await this.executeInner(action);
      return { ...result, durationMs: Date.now() - started };
    } catch (e) {
      const err = e instanceof ComputerUseError ? e : new ComputerUseError("internal_error", (e as Error).message);
      return {
        ok: false,
        method: "system",
        error: { code: err.code, message: err.message, hint: err.hint },
        durationMs: Date.now() - started,
      };
    }
  }

  private async executeInner(action: Action): Promise<Omit<ActionResult, "durationMs">> {
    const findEl = (el?: ElementRef): MockElementSpec | undefined => {
      if (!el) return undefined;
      return this.state.elements.find((e) => `mock:${e.id}` === el.id || e.id === el.id || e.name === el.name);
    };
    switch (action.type) {
      case "click":
      case "invoke": {
        this.assertStructuredIfElement(action.element);
        const el = findEl(action.element);
        if (!el) {
          if ("point" in action && action.point) {
            const hit = this.state.elements.find(
              (e) =>
                action.point!.x >= e.rect.x &&
                action.point!.x <= e.rect.x + e.rect.width &&
                action.point!.y >= e.rect.y &&
                action.point!.y <= e.rect.y + e.rect.height,
            );
            if (!hit) return { ok: true, method: "coordinate", point: { x: action.point.x, y: action.point.y } };
            return this.activate(hit, "coordinate");
          }
          throw new ComputerUseError("element_not_found", `mock: element not found`);
        }
        return this.activate(el, "semantic");
      }
      case "double_click":
      case "right_click":
      case "long_press": {
        const el = findEl(action.element);
        if (el) return this.activate(el, "semantic");
        return { ok: true, method: "coordinate", point: action.point ? { x: action.point.x, y: action.point.y } : undefined };
      }
      case "type":
      case "set_value": {
        const el = findEl(action.element);
        if (!el) throw new ComputerUseError("element_not_found", `mock: input element not found`);
        if (el.role !== "textfield") throw new ComputerUseError("invalid_request", `mock: "${el.name}" is not editable`);
        el.value = action.type === "type" ? action.text : action.value;
        this.state.eventLog.push(`set ${el.id}=${el.value}`);
        return { ok: true, method: "semantic", element: action.element };
      }
      case "toggle": {
        const el = findEl(action.element);
        if (!el) throw new ComputerUseError("element_not_found", `mock: toggle element not found`);
        const target = action.value ?? el.value !== "on";
        el.value = target ? "on" : "off";
        this.state.eventLog.push(`toggle ${el.id}=${el.value}`);
        return { ok: true, method: "semantic", element: action.element };
      }
      case "select": {
        const el = findEl(action.element);
        if (el && action.value !== undefined) {
          el.value = action.value;
          this.state.eventLog.push(`select ${el.id}=${action.value}`);
          return { ok: true, method: "semantic", element: action.element };
        }
        return { ok: true, method: "coordinate" };
      }
      case "clear": {
        const el = findEl(action.element);
        if (el) el.value = "";
        return { ok: true, method: "semantic", element: action.element };
      }
      case "launch_app":
        this.state.eventLog.push(`launch:${action.app}`);
        return { ok: true, method: "system" };
      case "terminate_app":
        this.state.eventLog.push(`terminate:${action.app}`);
        return { ok: true, method: "system" };
      case "focus":
        this.state.eventLog.push(`focus:${action.app ?? action.windowTitle}`);
        return { ok: true, method: "system" };
      case "press":
      case "hotkey":
        this.state.eventLog.push(`key:${action.type === "press" ? action.key : action.keys.join("+")}`);
        return { ok: true, method: "system" };
      case "scroll":
        this.state.eventLog.push(`scroll:${action.direction}`);
        return { ok: true, method: "coordinate" };
      case "move":
        return { ok: true, method: "coordinate", point: { x: action.point.x, y: action.point.y } };
      case "drag":
      case "swipe":
        this.state.eventLog.push(`drag`);
        return { ok: true, method: "coordinate" };
      case "back":
      case "home":
        this.state.eventLog.push(action.type);
        return { ok: true, method: "system" };
      case "wait":
        return { ok: true, method: "system" };
      case "finish":
      case "fail":
        return { ok: true, method: "system", detail: action.type };
      default:
        throw new ComputerUseError("invalid_request", "unhandled mock action");
    }
  }

  private assertStructuredIfElement(el?: ElementRef): void {
    if (el && this.structuredDisabled) this.assertStructured();
  }

  private activate(el: MockElementSpec, method: "semantic" | "coordinate"): Omit<ActionResult, "durationMs"> {
    if (el.role === "checkbox") {
      el.value = el.value === "on" ? "off" : "on";
      this.state.eventLog.push(`toggle ${el.id}=${el.value}`);
    } else if (el.role === "button") {
      this.state.eventLog.push(`click ${el.id}`);
    }
    return { ok: true, method, element: { id: `mock:${el.id}`, source: "uia", role: el.role, name: el.name, bounds: el.rect } };
  }

  async listApps(): Promise<AppInfo[]> {
    return [{ name: this.state.appName, frontmost: true }];
  }

  async listWindows(): Promise<WindowInfo[]> {
    return [{ id: "mock:win1", title: `${this.state.appName} — main`, app: this.state.appName, bounds: { x: 0, y: 0, width: 800, height: 600 }, focused: true }];
  }

  async launchApp(app: string, _options?: LaunchOptions): Promise<void> {
    this.state.eventLog.push(`launch:${app}`);
  }

  async terminateApp(app: string): Promise<void> {
    this.state.eventLog.push(`terminate:${app}`);
  }

  async focusTarget(options: { app?: string; windowTitle?: string }): Promise<void> {
    this.state.eventLog.push(`focus:${options.app ?? options.windowTitle}`);
  }
}
