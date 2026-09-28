/**
 * iOS / iPadOS PlatformAdapter (spec §5, §10, §33, §34).
 *
 * Two target kinds, distinguished everywhere:
 *
 *   1. SIMULATOR  { type: "simulator", platform: "ios", deviceId?: udid }
 *      - screenshot + app mgmt: `xcrun simctl` (always-honest fallback)
 *      - UI tree + input:       WDA if reachable, else idb, else NONE
 *        (accessibility=false with an install hint; tree/locate degrade
 *        to vision-only — documented, never faked)
 *
 *   2. REAL DEVICE { type: "device", platform: "ios", deviceId }
 *      - everything via WebDriverAgent HTTP (Appium-compatible subset);
 *        needs Developer Mode, WDA signing/provisioning, "Trust this
 *        computer", and a forwarded port (iproxy). Unreachable WDA is
 *        reported as permission_required with those hints.
 *
 * Coordinate space: iOS logical POINTS. Simulator screenshots are device
 * pixels (@2x/@3x); the scale comes from idb `describe` (screen_dimensions)
 * or is derived from WDA windowSize vs. screenshot pixel height. When
 * neither is available (simctl-only) scale=1 is assumed and the limitation
 * is stated in capabilities.notes — it is NOT silently hidden.
 *
 * UINode/ElementRef bounds are LOGICAL points
 * (attributes.boundsSpace = "logical"); divide by the screenshot scale
 * to fuse with vision coordinates.
 */
import {
  type Capabilities,
  type AppInfo,
  type ElementRef,
  type Observation,
  type Point,
  type PointInSpace,
  type ScreenInfo,
  type Screenshot,
  type Target,
  type TargetInfo,
  type UINode,
  type WindowInfo,
} from "../../core/types.js";
import type { Action, ActionResult } from "../../core/types-action.js";
import { ComputerUseError, permissionRequired, unsupported } from "../../core/errors.js";
import { processScreenshot, decodeImage, type ProcessOptions } from "../../screenshot/pipeline.js";
import type { ObserveOptions, PlatformAdapter, ScreenshotOptions, LaunchOptions } from "../adapter.js";
import { run as runText } from "../exec.js";
import { Simctl, probeSimctl, parseListapps, type RunBinaryFn, type RunFn, type SimctlOptions, type SimDevice } from "./simctl.js";
import { Idb, probeIdb, isClickableRole, isEditableRole, type IdbScreenDimensions } from "./idb.js";
import { WdaClient, WDA_SETUP_HINT, parseWdaSource, type FetchFn, type WdaSourceNode } from "./wda.js";
import { rectCenter } from "../../coordinate/index.js";

export interface IosAdapterOptions {
  target: Target;
  /** shared injectable runner for simctl + idb text commands */
  run?: RunFn;
  /** binary-safe runner (simctl screenshot to stdout) */
  runBinary?: RunBinaryFn;
  fetchFn?: FetchFn;
  /** override env IOS_WDA_URL/WDA_URL */
  wdaUrl?: string;
  idbPath?: string;
  simctl?: SimctlOptions;
  screenshot?: ProcessOptions;
}

type DeviceKind = "simulator" | "device";

interface ScreenMetrics {
  /** logical (points) size; 0 = unknown */
  width: number;
  height: number;
  /** points→pixels multiplier; 0 = unknown (assumed 1 with a note) */
  scale: number;
  source: "wda" | "idb" | "unknown";
}

export class IosAdapter implements PlatformAdapter {
  readonly platform = "ios";
  readonly kind: DeviceKind;

  private readonly opts: IosAdapterOptions;
  private readonly target: Target;
  private readonly simctl: Simctl;
  private readonly idb: Idb;
  private readonly wda: WdaClient;

  private simctlOk = false;
  private simctlError?: string;
  private device: SimDevice | undefined;
  private devices: SimDevice[] = [];
  private idbOk = false;
  private idbError?: string;
  private wdaReady = false;
  private wdaError?: string;
  private wdaState?: string;

  private metrics: ScreenMetrics = { width: 0, height: 0, scale: 0, source: "unknown" };
  private info!: TargetInfo;
  private caps!: Capabilities;
  private lastShot: Screenshot | null = null;

  private tree: UINode | null = null;
  private flat: UINode[] = [];
  private eidCache = new Map<string, string>();

  constructor(opts: IosAdapterOptions) {
    this.opts = opts;
    this.target = opts.target;
    this.targetCheck(opts.target);
    this.kind = opts.target.type === "simulator" ? "simulator" : "device";
    this.simctl = new Simctl({
      ...(opts.simctl ?? {}),
      run: opts.simctl?.run ?? opts.run,
      runBinary: opts.simctl?.runBinary ?? opts.runBinary,
    });
    this.idb = new Idb({ run: opts.run, idbPath: opts.idbPath });
    this.wda = new WdaClient({ baseUrl: opts.wdaUrl, fetchFn: opts.fetchFn });
  }

  private targetCheck(target: Target): void {
    if (target.type !== "simulator" && target.type !== "device") {
      throw new ComputerUseError(
        "invalid_request",
        `ios adapter requires target.type "simulator" or "device", got "${target.type}"`,
        { hint: "Use type=local + platform=macos for this machine's own UI." },
      );
    }
  }

  /* ============================= open/close ============================= */

  async open(): Promise<TargetInfo> {
    if (this.kind === "device" && !this.target.deviceId) {
      throw new ComputerUseError("invalid_request", "Real iOS devices require target.deviceId (the WDA/iproxy device id)", {
        hint: "Find the id via `idevice_id -l` (libimobiledevice) or Xcode → Devices and Simulators.",
      });
    }

    // Layer 1: simctl (simulators only)
    if (this.kind === "simulator") {
      const probe = await this.simctl.probe();
      this.simctlOk = probe.ok;
      this.simctlError = probe.error;
      if (probe.ok) {
        this.devices = await this.simctl.listDevices().catch(() => []);
        if (this.devices.length > 0 || this.target.deviceId) {
          try {
            this.device = this.simctl.pickDevice(this.devices, this.target.deviceId);
          } catch (e) {
            if (this.target.deviceId) throw e; // explicit UDID must exist
            this.simctlError = (e as Error).message;
          }
        }
      }
    }

    // Layer 2: WDA (only channel for real devices; preferred on simulators)
    const status = await this.wda.status().catch((e: ComputerUseError) => {
      this.wdaError = e.message;
      return null;
    });
    if (status) {
      this.wdaReady = status.ready;
      this.wdaState = status.state;
      if (!status.ready) this.wdaError = `WDA reports state "${status.state}", ready=${status.ready}`;
    }

    // Layer 3: idb (simulator tree/input fallback)
    if (this.kind === "simulator") {
      const probe = await probeIdb({ run: this.opts.run, idbPath: this.opts.idbPath });
      this.idbOk = probe.ok;
      this.idbError = probe.error;
    }

    await this.probeScreenMetrics();
    this.caps = this.computeCapabilities();

    const udid = this.device?.udid ?? this.target.deviceId;
    this.info = {
      id: `ios:${this.kind}:${udid ?? "default"}`,
      platform: "ios",
      type: this.target.type,
      deviceId: udid,
      name: `${this.device?.name ?? "iOS device"} (${this.kind})`,
      details: {
        kind: this.kind,
        udid: this.device?.udid,
        simulatorState: this.device?.state,
        runtime: this.device?.runtime,
        wda: { url: this.wda.baseUrl, ready: this.wdaReady, state: this.wdaState, error: this.wdaError },
        idb: { ok: this.idbOk, error: this.idbError },
        simctl: { ok: this.simctlOk, error: this.simctlError },
        screen: { ...this.metrics },
      },
    };
    return this.info;
  }

  async close(): Promise<void> {
    await this.wda.deleteSession();
    this.tree = null;
    this.flat = [];
    this.eidCache.clear();
  }

  getTargetInfo(): TargetInfo {
    return this.info;
  }

  getCapabilities(): Capabilities {
    return this.caps;
  }

  /* ========================== capability matrix ========================= */

  /**
   * Honest matrix (spec §33):
   *
   *   layer                      screenshot   tree/input   appControl
   *   device + WDA               yes          yes          yes
   *   device, no WDA             no           no           no   (+setup hints)
   *   sim + simctl + WDA         yes          yes          yes
   *   sim + simctl + idb         yes (@scale) yes          yes
   *   sim + simctl only          yes (scale?) no           yes
   *   sim, nothing installed     no           no           no
   *
   * windowControl / dom / clipboard / multiDisplay are always false on iOS.
   */
  private computeCapabilities(): Capabilities {
    const notes: string[] = [];
    const sim = this.kind === "simulator";
    const idbUsable = sim && this.idbOk;
    const screenshot = this.wdaReady || (sim && this.simctlOk);
    const accessibility = this.wdaReady || idbUsable;

    if (this.kind === "device" && !this.wdaReady) {
      notes.push(`WebDriverAgent not reachable at ${this.wda.baseUrl}. ${WDA_SETUP_HINT}`);
    }
    if (sim && !this.simctlOk) {
      notes.push(`xcrun simctl unavailable${this.simctlError ? `: ${this.simctlError}` : ""} — install Xcode; no simulator screenshots or app management (docs/install/ios.md).`);
    }
    if (sim && !idbUsable && !this.wdaReady) {
      notes.push(
        "install idb: brew install idb-companion; pip install fb-idb — without idb (or WDA) there is no accessibility tree, no locate() and no touch input; tree/locate degrade to vision-only.",
      );
    }
    if (screenshot && this.metrics.scale === 0 && !this.wdaReady) {
      notes.push(
        "Screenshot scale unknown (no WDA/idb): simctl screenshots are device pixels (@2x/@3x) but scale is assumed 1 — treat screenshot-space points as approximate.",
      );
    }
    notes.push("iOS: no global 'back' key (gesture-based); home requires WDA; no window control; clipboard not implemented.");

    return {
      screenshot,
      accessibility,
      dom: false,
      globalInput: accessibility,
      windowControl: false,
      appControl: this.wdaReady || (sim && this.simctlOk),
      clipboard: false,
      multiDisplay: false,
      notes,
    };
  }

  /* ========================== screen metrics =========================== */

  private async probeScreenMetrics(): Promise<void> {
    // WDA: logical size from windowSize; scale stays unknown until the
    // first screenshot (px height / logical height).
    if (this.wdaReady) {
      const size = await this.wda.windowSize().catch(() => null);
      if (size && size.width > 0 && size.height > 0) {
        this.metrics = { width: size.width, height: size.height, scale: this.metrics.scale, source: "wda" };
      }
    }
    // idb: exact scale + logical size for simulators.
    if (this.kind === "simulator" && this.idbOk && this.device) {
      const desc = await this.idb.describeDevice(this.device.udid).catch(() => null);
      const screen = desc?.screen;
      if (screen && screen.scale > 0) {
        this.metrics = {
          width: this.metrics.width > 0 ? this.metrics.width : screen.width,
          height: this.metrics.height > 0 ? this.metrics.height : screen.height,
          scale: screen.scale,
          source: this.metrics.source === "wda" ? "wda" : "idb",
        };
      }
    }
  }

  private orientation(w: number, h: number): "portrait" | "landscape" {
    return w > h ? "landscape" : "portrait";
  }

  async getScreenInfo(): Promise<ScreenInfo> {
    let { width, height, scale } = this.metrics;
    if ((width === 0 || height === 0) && this.lastShot) {
      const s = this.lastShot.scale > 0 ? this.lastShot.scale : 1;
      width = this.lastShot.width / s;
      height = this.lastShot.height / s;
      scale = scale || s;
    }
    return {
      displays: [{ id: "main", x: 0, y: 0, width, height, scale: scale || 1, primary: true }],
      orientation: this.orientation(width, height),
      width,
      height,
    };
  }

  /* ============================= screenshot ============================= */

  async screenshot(options: ScreenshotOptions = {}): Promise<Screenshot> {
    if (options.region || options.windowId || options.displayId) {
      throw unsupported("region/window screenshots", "simctl and WDA capture the full device screen only");
    }
    let raw: Buffer;
    if (this.wdaReady) {
      raw = await this.wda.screenshot();
    } else if (this.kind === "simulator" && this.simctlOk && this.device) {
      raw = await this.simctl.screenshot(this.device.udid);
    } else {
      throw this.unavailableError("Screenshot");
    }

    // Determine scale honestly: known (idb) > derived (WDA px/logical) > 1.
    let scale = this.metrics.scale;
    const px = decodedSize(raw);
    if (!scale && this.metrics.height > 0 && px.height > 0) {
      scale = Math.min(4, Math.max(1, Math.round(px.height / this.metrics.height)));
    }
    if (!scale) scale = 1;

    const w = this.metrics.width || px.width / scale;
    const h = this.metrics.height || px.height / scale;
    const shot = processScreenshot(
      raw,
      {
        targetId: this.info.id,
        scale,
        origin: { x: 0, y: 0 },
        orientation: this.orientation(w, h),
      },
      this.opts.screenshot,
    );
    this.lastShot = shot;
    return shot;
  }

  /* ============================== observe ============================== */

  async observe(options: ObserveOptions = {}): Promise<Observation> {
    const shot = options.includeScreenshot === false ? undefined : await this.screenshot().catch(() => undefined);
    const tree = options.includeUITree === false ? null : await this.refreshTree().catch(() => null);
    const activeApp = this.wdaReady
      ? await this.wda
          .activeAppInfo()
          .then((a) =>
            a.name || a.bundleId
              ? { name: a.name ?? a.bundleId!, identifier: a.bundleId, frontmost: true }
              : undefined,
          )
          .catch(() => undefined)
      : undefined;
    return {
      target: this.info,
      screen: await this.getScreenInfo(),
      screenshot: shot,
      activeApp,
      uiTree: tree ? pruneDepth(tree, options.maxTreeDepth ?? Number.POSITIVE_INFINITY) : undefined,
      capabilities: this.caps,
      capturedAt: Date.now(),
    };
  }

  /* =============================== tree ================================ */

  /** WDA source first, idb describe-all second, else null (vision-only). */
  async refreshTree(): Promise<UINode | null> {
    if (this.wdaReady) {
      const src = await this.wda.source().catch(() => null);
      if (src) {
        this.tree = wdaSourceToUINode(src);
        this.flat = flatten(this.tree);
        return this.tree;
      }
    }
    if (this.kind === "simulator" && this.idbOk && this.device) {
      const tree = await this.idb.describeAllTree(this.device.udid).catch(() => null);
      if (tree) {
        this.tree = tree;
        this.flat = flatten(tree);
        return this.tree;
      }
    }
    this.tree = null;
    this.flat = [];
    return null;
  }

  /* =============================== locate ============================== */

  async locate(descriptor: {
    role?: string;
    name?: string;
    text?: string;
    resourceId?: string;
    css?: string;
    xpath?: string;
    testId?: string;
    index?: number;
  }): Promise<{ element: ElementRef } | null> {
    if (!this.caps.accessibility) return null; // honest: vision-only mode
    if (descriptor.css || descriptor.xpath) {
      throw unsupported("css/xpath locate", "CSS/XPath apply to web/DOM trees, not the iOS accessibility tree");
    }
    if (!this.tree) await this.refreshTree();
    if (this.flat.length === 0) return null;

    const identity = descriptor.resourceId ?? descriptor.testId;
    const wantName = (descriptor.name ?? descriptor.text ?? "").toLowerCase();
    const wantRole = descriptor.role ? normalizeRoleQuery(descriptor.role) : null;
    if (identity === undefined && !wantName && !wantRole) return null;

    const matches = this.flat.filter((el) => {
      if (identity !== undefined) return el.attributes?.identifier === identity;
      let ok = true;
      if (wantName) {
        const name = (el.name ?? "").toLowerCase();
        const id = String(el.attributes?.identifier ?? "").toLowerCase();
        ok = (!!name && (name.includes(wantName) || wantName.includes(name))) || (!!id && id.includes(wantName));
      }
      if (ok && wantRole) ok = el.role === wantRole;
      return ok;
    });
    const pick = matches[descriptor.index ?? 0];
    if (!pick) return null;
    const element: ElementRef = {
      id: pick.id,
      source: pick.source,
      role: pick.role,
      name: pick.name,
      value: pick.value,
      description: pick.description,
      bounds: pick.bounds,
      clickable: pick.clickable,
      editable: pick.editable,
      enabled: pick.enabled,
      checked: pick.checked,
      selected: pick.selected,
      focused: pick.focused,
      attributes: pick.attributes,
    };
    return { element };
  }

  /* ============================== actions ============================== */

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
      case "invoke": {
        if (action.element) {
          const resolved = await this.resolveElementTarget(action.element);
          if (resolved.kind === "wda-eid") {
            await this.wda.clickElement(resolved.eid);
            return { ok: true, method: "semantic", element: action.element };
          }
          await this.inputTap(resolved.point);
          return { ok: true, method: "coordinate", element: action.element, point: resolved.point };
        }
        if ("point" in action && action.point) {
          const pt = this.logicalFromPointInSpace(action.point);
          await this.inputTap(pt);
          return { ok: true, method: "coordinate", point: pt };
        }
        throw new ComputerUseError("invalid_request", "click requires a point or an element with bounds");
      }

      case "double_click": {
        const pt = await this.targetPoint(action.element, action.point);
        if (this.wdaReady) {
          await this.wda.doubleTap(pt.x, pt.y);
        } else {
          await this.idbInput().doubleTap(pt.x, pt.y);
        }
        return { ok: true, method: "coordinate", point: pt };
      }

      case "long_press": {
        const pt = await this.targetPoint(action.element, action.point);
        if (this.wdaReady) {
          await this.wda.touchAndHold(pt.x, pt.y, (action.durationMs ?? 800) / 1000);
        } else {
          await this.idbInput().longPress(pt.x, pt.y, action.durationMs ?? 800);
        }
        return { ok: true, method: "coordinate", point: pt };
      }

      case "right_click":
        throw unsupported("right_click", "touch has no secondary click; iOS uses long-press");

      case "move":
        throw unsupported("move", "touch screens have no hover pointer");

      case "drag":
      case "swipe": {
        if (!action.from || !action.to) throw new ComputerUseError("invalid_request", `${action.type} requires from+to`);
        const from = await this.endpointPoint(action.from);
        const to = await this.endpointPoint(action.to);
        await this.inputSwipe(from, to, action.durationMs ?? 300);
        return { ok: true, method: "coordinate", point: to };
      }

      case "scroll": {
        const size = this.requireScreenSize();
        const cx = size.width / 2;
        const cy = size.height / 2;
        // fraction of the half-extent swept per scroll; amount clamped 1..3
        const f = 0.2 * Math.min(Math.max(action.amount ?? 1, 1), 3);
        // Convention: scroll DOWN reveals content below → finger swipes UP.
        const gestures: Record<"up" | "down" | "left" | "right", [Point, Point]> = {
          down: [{ x: cx, y: cy + size.height * f }, { x: cx, y: cy - size.height * f }],
          up: [{ x: cx, y: cy - size.height * f }, { x: cx, y: cy + size.height * f }],
          left: [{ x: cx + size.width * f, y: cy }, { x: cx - size.width * f, y: cy }],
          right: [{ x: cx - size.width * f, y: cy }, { x: cx + size.width * f, y: cy }],
        };
        const [from, to] = gestures[action.direction];
        if (action.point) {
          const anchor = this.logicalFromPointInSpace(action.point);
          const dx = anchor.x - cx;
          const dy = anchor.y - cy;
          from.x += dx;
          from.y += dy;
          to.x += dx;
          to.y += dy;
        }
        await this.inputSwipe(from, to, 300);
        return { ok: true, method: "coordinate", point: to };
      }

      case "type": {
        const text = action.text + (action.submit ? "\n" : "");
        let semantic = false;
        if (action.element) {
          const resolved = await this.resolveElementTarget(action.element);
          if (resolved.kind === "wda-eid") {
            await this.wda.elementValue(resolved.eid, text);
            return { ok: true, method: "semantic", element: action.element };
          }
          await this.inputTap(resolved.point);
        }
        if (this.wdaReady) {
          await this.wda.typeText(text);
          semantic = !!action.element;
        } else {
          await this.idbInput().text(text);
        }
        return { ok: true, method: semantic ? "semantic" : "coordinate", element: action.element };
      }

      case "set_value": {
        if (!this.wdaReady) {
          throw unsupported("set_value", "replacing text requires WebDriverAgent (idb can type but not clear)");
        }
        const eid = await this.resolveEid(action.element);
        await this.wda.elementClear(eid);
        await this.wda.elementValue(eid, action.value);
        return { ok: true, method: "semantic", element: action.element };
      }

      case "clear": {
        if (action.element && this.wdaReady) {
          const eid = await this.resolveEid(action.element);
          await this.wda.elementClear(eid);
          return { ok: true, method: "semantic", element: action.element };
        }
        if (this.wdaReady) {
          // no select-all on iOS; approximate by backspacing the focused field
          await this.wda.keys("\b".repeat(30));
          return { ok: true, method: "coordinate" };
        }
        throw unsupported("clear", "clearing text requires WebDriverAgent (simctl cannot send keys; idb cannot clear)");
      }

      case "press": {
        const mapped = keyToKeyboardChar(action.key);
        if (!mapped) {
          throw unsupported(
            `press "${action.key}"`,
            "iOS has no global hardware keys; only software-keyboard characters are supported (enter, backspace, tab, single chars)",
          );
        }
        if (this.wdaReady) {
          await this.wda.keys(mapped);
          return { ok: true, method: "coordinate" };
        }
        throw unsupported("press without WebDriverAgent", "idb key injection needs HID usage codes that are not mapped; run WDA for keyboard input");
      }

      case "hotkey":
        throw unsupported("hotkey", "iOS has no global modifier-key shortcuts");

      case "select": {
        if (action.value !== undefined && this.wdaReady) {
          const eid = await this.resolveEid(action.element);
          await this.wda.elementClear(eid);
          await this.wda.elementValue(eid, action.value);
          return { ok: true, method: "semantic", element: action.element };
        }
        const resolved = await this.resolveElementTarget(action.element);
        if (resolved.kind === "wda-eid") {
          await this.wda.clickElement(resolved.eid);
          return { ok: true, method: "semantic", element: action.element };
        }
        await this.inputTap(resolved.point);
        return { ok: true, method: "coordinate", element: action.element, point: resolved.point };
      }

      case "toggle": {
        // UISwitch toggles on tap; iOS has no separate AX toggle write
        const resolved = await this.resolveElementTarget(action.element);
        if (resolved.kind === "wda-eid") {
          await this.wda.clickElement(resolved.eid);
          return { ok: true, method: "semantic", element: action.element };
        }
        await this.inputTap(resolved.point);
        return { ok: true, method: "coordinate", element: action.element, point: resolved.point };
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
        throw unsupported(
          "back",
          "iOS has no global back key; navigation is per-app — tap the app's back button (locate by label) or edge-swipe from the left edge",
        );

      case "home":
        if (this.wdaReady) {
          await this.wda.pressHome();
          return { ok: true, method: "system" };
        }
        throw unsupported("home", "the iOS home button is only reachable via WebDriverAgent (POST /wda/pressHome); simctl and idb cannot press it");

      case "wait":
        await new Promise((r) => setTimeout(r, action.durationMs));
        return { ok: true, method: "system" };

      case "finish":
      case "fail":
        return { ok: true, method: "system", detail: action.type };

      default:
        throw new ComputerUseError("invalid_request", "Unhandled action type on iOS");
    }
  }

  /* ========================= element resolution ======================== */

  /** Element action → WDA element id (semantic) or logical center point. */
  private async resolveElementTarget(el: ElementRef): Promise<{ kind: "wda-eid"; eid: string } | { kind: "point"; point: Point }> {
    const ours = el.source === "xcuitest" || el.id.startsWith("ios:");
    if (ours && this.wdaReady) {
      const eid = await this.resolveEid(el).catch(() => null);
      if (eid) return { kind: "wda-eid", eid };
    }
    if (el.bounds) return { kind: "point", point: rectCenter(el.bounds) };
    throw new ComputerUseError("element_not_found", `Element ${el.id} has no bounds and no WDA handle`, {
      hint: "Re-observe so elements carry fresh bounds, or run WDA for semantic element handles.",
    });
  }

  /** Find the WDA element id for a tree element via accessibility id. */
  private async resolveEid(el: ElementRef): Promise<string> {
    const cached = this.eidCache.get(el.id);
    if (cached) return cached;
    const handle = (el.attributes?.identifier as string | undefined) ?? el.name ?? el.value ?? "";
    if (!handle) throw new ComputerUseError("element_not_found", `Element ${el.id} has no accessibility id/label to search for`);
    const ids = await this.wda.findElements("accessibility id", handle);
    if (ids.length === 0) {
      throw new ComputerUseError("element_not_found", `WDA found no element with accessibility id "${handle}"`, {
        hint: "The tree may be stale — re-observe, or act by coordinates.",
      });
    }
    const eid = ids[0]!;
    this.eidCache.set(el.id, eid);
    return eid;
  }

  private async targetPoint(el: ElementRef | undefined, p: PointInSpace | undefined): Promise<Point> {
    if (p) return this.logicalFromPointInSpace(p);
    if (el?.bounds) return rectCenter(el.bounds);
    throw new ComputerUseError("invalid_request", "pointer action needs a point or an element with bounds");
  }

  private async endpointPoint(t: { element?: ElementRef; point?: PointInSpace }): Promise<Point> {
    if (t.point) return this.logicalFromPointInSpace(t.point);
    if (t.element?.bounds) return rectCenter(t.element.bounds);
    throw new ComputerUseError("invalid_request", "drag/swipe endpoints need a point or an element with bounds");
  }

  /** Accept points in any declared space; iOS logical points are canonical. */
  private logicalFromPointInSpace(p: PointInSpace): Point {
    const shotScale = this.lastShot && this.lastShot.scale > 0 ? this.lastShot.scale : this.metrics.scale || 1;
    switch (p.space ?? "screenshot") {
      case "logical":
        return { x: p.x, y: p.y };
      case "physical":
      case "screenshot":
        return { x: p.x / shotScale, y: p.y / shotScale };
      case "normalized": {
        const size = this.requireScreenSize();
        return { x: (p.x / 1000) * size.width, y: (p.y / 1000) * size.height };
      }
      default:
        return { x: p.x, y: p.y };
    }
  }

  private requireScreenSize(): { width: number; height: number } {
    if (this.metrics.width > 0 && this.metrics.height > 0) return { width: this.metrics.width, height: this.metrics.height };
    if (this.lastShot) {
      const s = this.lastShot.scale > 0 ? this.lastShot.scale : 1;
      return { width: this.lastShot.width / s, height: this.lastShot.height / s };
    }
    throw new ComputerUseError("invalid_request", "Screen size unknown — take a screenshot first", {
      details: { metrics: { ...this.metrics } },
    });
  }

  /* ============================= input layer =========================== */

  /** idb runner bound to the resolved simulator UDID. */
  private idbInput(): BoundIdb {
    if (this.kind === "device") {
      // real devices: input requires WDA; give the full setup hints
      throw this.unavailableError("Touch input");
    }
    if (!this.idbOk) {
      throw permissionRequired(
        "Touch input",
        "install idb: brew install idb-companion; pip install fb-idb (or run WebDriverAgent) — simctl cannot inject touch input",
        { details: { kind: this.kind, wdaReady: this.wdaReady, idbOk: this.idbOk } },
      );
    }
    if (!this.device) {
      throw new ComputerUseError("device_not_found", "idb input requires a simulator UDID, but simctl is unavailable to resolve one", {
        hint: "Install Xcode so `xcrun simctl list devices -j` can name the booted simulator.",
      });
    }
    return new BoundIdb(this.idb, this.device.udid);
  }

  private async inputTap(pt: Point): Promise<void> {
    if (this.wdaReady) return this.wda.tap(pt.x, pt.y);
    return this.idbInput().tap(pt.x, pt.y);
  }

  private async inputSwipe(from: Point, to: Point, durationMs: number): Promise<void> {
    if (this.wdaReady) return this.wda.drag(from.x, from.y, to.x, to.y, durationMs / 1000);
    return this.idbInput().swipe(from.x, from.y, to.x, to.y, durationMs);
  }

  /** Unified honest failure for operations with no available channel. */
  private unavailableError(what: string): ComputerUseError {
    if (this.kind === "device") {
      return permissionRequired(what, WDA_SETUP_HINT, {
        details: { kind: this.kind, wdaUrl: this.wda.baseUrl, error: this.wdaError },
      });
    }
    return permissionRequired(what, "Install Xcode (simctl) and idb (brew install idb-companion; pip install fb-idb), or run WebDriverAgent — docs/install/ios.md", {
      details: { kind: this.kind, simctl: this.simctlOk, idb: this.idbOk, wda: this.wdaReady },
    });
  }

  /* ============================== app mgmt ============================== */

  async listApps(): Promise<AppInfo[]> {
    let apps: AppInfo[] = [];
    let frontmostId: string | undefined;

    if (this.wdaReady) {
      const [list, active] = await Promise.all([
        this.wda.appsList().catch(() => []),
        this.wda.activeAppInfo().catch(() => null),
      ]);
      apps = list.map((a) => ({ name: a.name ?? a.bundleId, identifier: a.bundleId }));
      frontmostId = active?.bundleId;
    } else if (this.kind === "simulator" && this.simctlOk && this.device) {
      const run = this.opts.run ?? this.opts.simctl?.run ?? runText;
      const r = await run("xcrun", ["simctl", "listapps", this.device.udid], 30_000).catch(() => null);
      if (r && r.code === 0) {
        apps = parseListapps(r.stdout).map((a) => ({ name: a.name ?? a.bundleId, identifier: a.bundleId }));
      }
    }

    if (frontmostId) {
      for (const a of apps) if (a.identifier === frontmostId) a.frontmost = true;
    }
    return apps;
  }

  async launchApp(app: string, options: LaunchOptions = {}): Promise<void> {
    if (this.wdaReady) {
      await this.wda.appLaunch(app);
      return;
    }
    if (this.kind === "simulator" && this.simctlOk && this.device) {
      await this.simctl.launchApp(this.device.udid, app, options.args);
      return;
    }
    throw this.unavailableError(`Launching "${app}"`);
  }

  async terminateApp(app: string): Promise<void> {
    if (this.wdaReady) {
      await this.wda.appTerminate(app);
      return;
    }
    if (this.kind === "simulator" && this.simctlOk && this.device) {
      await this.simctl.terminateApp(this.device.udid, app);
      return;
    }
    throw this.unavailableError(`Terminating "${app}"`);
  }

  async focusTarget(options: { app?: string; windowTitle?: string }): Promise<void> {
    if (!options.app) {
      throw unsupported("focus by windowTitle", "iOS apps have no window titles; focus an app by bundle id");
    }
    const app = options.app;
    if (this.wdaReady) {
      await this.wda.appActivate(app).catch(() => this.wda.appLaunch(app));
      return;
    }
    if (this.kind === "simulator" && this.simctlOk && this.device) {
      // launching an already-running app activates it
      await this.simctl.launchApp(this.device.udid, app);
      return;
    }
    throw this.unavailableError(`Focusing "${app}"`);
  }

  /** Simulator-only extras (not part of PlatformAdapter). */
  async installApp(appPath: string): Promise<void> {
    if (this.kind === "simulator" && this.simctlOk && this.device) {
      await this.simctl.installApp(this.device.udid, appPath);
      return;
    }
    throw unsupported("installApp", "simctl install works on simulators only; real devices install via Xcode/Finder");
  }

  async openUrl(url: string): Promise<void> {
    if (this.wdaReady) {
      await this.wda.openUrl(url);
      return;
    }
    if (this.kind === "simulator" && this.simctlOk && this.device) {
      await this.simctl.openUrl(this.device.udid, url);
      return;
    }
    throw this.unavailableError(`Opening URL "${url}"`);
  }

  async listWindows(): Promise<WindowInfo[]> {
    // iOS apps have no addressable desktop windows.
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Probe for the router (AdapterRegistration.probe — must not throw)   */
/* ------------------------------------------------------------------ */

export interface IosProbeOptions {
  run?: RunFn;
  runBinary?: RunBinaryFn;
  fetchFn?: FetchFn;
  wdaUrl?: string;
  idbPath?: string;
  xcrunPath?: string;
}

/** Cheap availability probe for list_targets: simctl present with at least
 * one simulator, or WDA reachable ⇒ available. Never throws. */
export async function iosProbe(opts: IosProbeOptions = {}): Promise<{
  available: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}> {
  const simctlProbe = await probeSimctl(opts.run ?? (async (cmd, args, t) => runText(cmd, args, t)), opts.xcrunPath ?? "xcrun").catch(() => ({
    ok: false as const,
    error: "probe failed",
  }));
  const idbProbe = await probeIdb({ run: opts.run, idbPath: opts.idbPath }).catch(() => ({ ok: false as const, error: "probe failed" }));
  const wda = new WdaClient({ baseUrl: opts.wdaUrl, fetchFn: opts.fetchFn });
  const status = await wda
    .status()
    .then(
      (s) => ({ ready: s.ready, state: s.state, error: undefined as string | undefined }),
      (e: ComputerUseError) => ({ ready: false, state: "unreachable", error: e.message }),
    );

  const details: Record<string, unknown> = {
    simctl: simctlProbe.ok ? { ok: true, path: simctlProbe.path } : { ok: false, error: simctlProbe.error },
    idb: idbProbe.ok ? { ok: true, path: idbProbe.path } : { ok: false, error: idbProbe.error },
    wda: status.ready ? { ok: true, url: wda.baseUrl } : { ok: false, url: wda.baseUrl, error: status.error ?? status.state },
  };

  let simulatorCount = 0;
  if (simctlProbe.ok) {
    const devices = await new Simctl({ run: opts.run, runBinary: opts.runBinary, xcrunPath: opts.xcrunPath })
      .listDevices()
      .catch(() => [] as SimDevice[]);
    simulatorCount = devices.length;
    details.simulators = devices.length;
    details.booted = devices.filter((d) => d.state === "Booted").map((d) => d.udid);
  }

  const available = (simctlProbe.ok && simulatorCount > 0) || status.ready;
  return {
    available,
    reason: available
      ? undefined
      : "No iOS target: xcrun simctl unavailable (needs Xcode) or no simulators, and WebDriverAgent not reachable (real-device automation).",
    details,
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Software-keyboard characters WDA can synthesize. */
function keyToKeyboardChar(key: string): string | null {
  const k = key.toLowerCase();
  if (k === "enter" || k === "return") return "\n";
  if (k === "backspace" || k === "delete") return "\b";
  if (k === "tab") return "\t";
  if (key.length === 1) return key;
  return null;
}

function normalizeRoleQuery(role: string): string {
  const raw = role.replace(/^XCUIElementType/, "").trim().toLowerCase();
  if (raw === "statictext") return "text";
  if (raw === "textview") return "textarea";
  return raw || "unknown";
}

function wdaSourceToUINode(n: WdaSourceNode, path = "0"): UINode {
  const role = n.role;
  return {
    id: `ios:wda/${path}`,
    source: "xcuitest",
    role,
    name: n.label ?? n.name,
    value: n.value,
    bounds: n.frame,
    clickable: isClickableRole(role) && n.enabled,
    editable: isEditableRole(role) && n.enabled,
    enabled: n.enabled,
    attributes: { origin: "wda", identifier: n.identifier ?? null, boundsSpace: "logical" },
    children: n.children.map((c, i) => wdaSourceToUINode(c, `${path}/${i}`)),
  };
}

function flatten(root: UINode): UINode[] {
  const out: UINode[] = [];
  const walk = (n: UINode): void => {
    out.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
}

function pruneDepth(node: UINode, maxDepth: number, depth = 1): UINode {
  if (depth >= maxDepth) return { ...node, children: undefined };
  return { ...node, children: node.children?.map((c) => pruneDepth(c, maxDepth, depth + 1)) };
}

/** Screenshot pixel size, needed before processScreenshot for scale math. */
function decodedSize(raw: Buffer): { width: number; height: number } {
  const img = decodeImage(raw);
  return { width: img.width, height: img.height };
}

export type { IdbScreenDimensions };

/** Idb bound to a specific simulator UDID (input-call ergonomics). */
class BoundIdb {
  constructor(private readonly inner: Idb, private readonly udid: string) {}
  tap(x: number, y: number): Promise<void> {
    return this.inner.tap(this.udid, x, y);
  }
  doubleTap(x: number, y: number): Promise<void> {
    return this.inner.doubleTap(this.udid, x, y);
  }
  longPress(x: number, y: number, durationMs = 800): Promise<void> {
    return this.inner.longPress(this.udid, x, y, durationMs);
  }
  text(text: string): Promise<void> {
    return this.inner.text(this.udid, text);
  }
  swipe(fromX: number, fromY: number, toX: number, toY: number, durationMs = 300): Promise<void> {
    return this.inner.swipe(this.udid, fromX, fromY, toX, toY, durationMs);
  }
}
