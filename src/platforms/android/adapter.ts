/**
 * Android PlatformAdapter — structured-first GUI automation over plain adb.
 *
 * STRUCTURED-FIRST:
 *   - UI hierarchy from `uiautomator dump` (+ `cat`), parsed into UINode
 *     trees with stable `uia:<i>/<j>/…` paths.
 *   - Semantic actions RE-DUMP right before acting and re-match the element
 *     (path → attribute identity), then `adb shell input` on the node
 *     CENTER. uiautomator over plain adb has NO remote method invocation —
 *     tap-at-center is the honest semantic channel; documented in caps.notes.
 *   - Unicode typing only with the ADBKeyboard IME (probed via
 *     `ime list -s`); otherwise `input text` is ASCII-only (spaces → %s).
 *
 * Coordinate space: PHYSICAL pixels (screenshot space == physical; screencap
 * returns physical resolution). Screenshot.scale = density/160 so image px
 * map to DIP when a consumer needs logical coordinates.
 *
 * NOT unit-testable here and honestly out of scope: real-device E2E. All
 * behavior in tests is proven against mocked adb output; the exec impl is
 * injectable (constructor) so tests run on hosts without adb.
 */
import {
  type AppInfo,
  type Capabilities,
  type ElementRef,
  type Observation,
  type Orientation,
  type ScreenInfo,
  type Screenshot,
  type TargetInfo,
  type UINode,
  type WindowInfo,
  type PointInSpace,
  NO_CAPABILITIES,
} from "../../core/types.js";
import type { Action, ActionResult } from "../../core/types-action.js";
import { ComputerUseError, unsupported } from "../../core/errors.js";
import {
  averageHash,
  crop as cropImage,
  decodeImage,
  encodePng,
  processScreenshot,
  type ProcessOptions,
} from "../../screenshot/pipeline.js";
import type { LaunchOptions, ObserveOptions, PlatformAdapter, ScreenshotOptions } from "../adapter.js";
import { AdbClient, quoteDeviceArg, type AdbDevice, type AdbExecFn } from "./adb.js";
import {
  centerOf,
  findBy,
  nodeStillMatches,
  parseDump,
  resolveNode,
  toElementRef,
  type DumpQuery,
} from "./uiautomator.js";

export const DUMP_PATH = "/sdcard/window_dump.xml";
const ADB_KEYBOARD_PKG = "com.android.adbkeyboard";
const ADB_KEYBOARD_IME = "com.android.adbkeyboard/.AdbIME";

/** Subset of android.view.KeyEvent codes reachable through `input keyevent`. */
const KEYCODES: Record<string, number> = {
  enter: 66,
  back: 4,
  home: 3,
  app_switch: 187, // recents
  del: 67,
  forward_del: 112,
  tab: 61,
  space: 62,
  escape: 111,
  volume_up: 24,
  volume_down: 25,
  volume_mute: 164,
  power: 26,
  menu: 82,
  search: 84,
  camera: 27,
  focus: 80,
  dpad_up: 19,
  dpad_down: 20,
  dpad_left: 21,
  dpad_right: 22,
  dpad_center: 23,
  page_up: 92,
  page_down: 93,
  move_home: 122,
  move_end: 123,
  wake_up: 224,
  brightness_up: 221,
  brightness_down: 220,
  media_play_pause: 85,
  media_next: 87,
  media_previous: 88,
};

export interface AndroidAdapterOptions {
  /** adb serial (Target.deviceId). Required when >1 device is attached. */
  deviceId?: string;
  /** Explicit adb binary path (tests); otherwise discovered. */
  adbPath?: string;
  /** Injectable exec impl (tests). */
  exec?: AdbExecFn;
  /** Injectable discovery (tests). */
  discover?: () => string | null;
  /** Vision pipeline options (downscale/recompress) for screenshots. */
  screenshot?: ProcessOptions;
  /** Delay before a post-interaction re-dump (UI settle), ms. Default 400. */
  settleMs?: number;
}

interface ScreenState {
  width: number; // physical px
  height: number; // physical px
  density: number; // dpi
  rotation: number; // user_rotation (0-3; 0 when unset/auto)
}

/** "Physical size: 1080x2340" (+ optional "Override size:") → active px size. */
export function parseWmSize(out: string): { width: number; height: number } | null {
  const lines = out.split("\n").map((l) => l.trim());
  const physical = lines.find((l) => l.startsWith("Physical size:"))?.replace("Physical size:", "").trim();
  const override = lines.find((l) => l.startsWith("Override size:"))?.replace("Override size:", "").trim();
  const chosen = override ?? physical;
  if (!chosen) return null;
  const m = chosen.match(/^(\d+)x(\d+)$/);
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** "Physical density: 440" (+ optional "Override density:") → active dpi. */
export function parseWmDensity(out: string): number | null {
  const lines = out.split("\n").map((l) => l.trim());
  const physical = lines.find((l) => l.startsWith("Physical density:"))?.replace("Physical density:", "").trim();
  const override = lines.find((l) => l.startsWith("Override density:"))?.replace("Override density:", "").trim();
  const chosen = override ?? physical;
  if (!chosen) return null;
  const n = Number.parseFloat(chosen);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export class AndroidAdapter implements PlatformAdapter {
  readonly platform = "android";
  private adb: AdbClient;
  private serial = "";
  private info: TargetInfo | null = null;
  private caps: Capabilities = NO_CAPABILITIES;
  private screen: ScreenState = { width: 0, height: 0, density: 160, rotation: 0 };
  private unicodeInput = false;
  private screenOff = false;
  private dumpVerified = false; // "probe once": flipped on the first successful dump

  constructor(private readonly opts: AndroidAdapterOptions = {}) {
    this.adb = new AdbClient({ adbPath: opts.adbPath, exec: opts.exec, discover: opts.discover });
  }

  // ---------------------------------------------------------------- open/close

  async open(): Promise<TargetInfo> {
    const devices = await this.adb.devices();
    const serial = this.selectDevice(devices);
    this.serial = serial;
    const dev = devices.find((d) => d.serial === serial)!;

    // Reachability + geometry probes. wm size failing here means the device
    // dropped between `devices` and now — let adb's honest error propagate.
    const size = await this.adb.shell(serial, ["wm", "size"], { timeoutMs: 10_000 });
    const parsed = parseWmSize(size);
    if (!parsed) {
      throw new ComputerUseError("internal_error", `wm size unparsable: ${size.slice(0, 120)}`);
    }
    this.screen = { ...this.screen, width: parsed.width, height: parsed.height };

    const densityOut = await this.adb.shell(serial, ["wm", "density"], { timeoutMs: 10_000 }).catch(() => "");
    const density = parseWmDensity(densityOut);
    if (density) this.screen.density = density;

    const rotationOut = await this.adb
      .shell(serial, ["settings", "get", "system", "user_rotation"], { timeoutMs: 10_000 })
      .catch(() => "");
    const rot = Number.parseInt(rotationOut, 10);
    this.screen.rotation = Number.isFinite(rot) && rot >= 0 && rot <= 3 ? rot : 0;

    const imeOut = await this.adb.shell(serial, ["ime", "list", "-s"], { timeoutMs: 10_000 }).catch(() => "");
    this.unicodeInput = imeOut.includes(ADB_KEYBOARD_PKG);

    const powerOut = await this.adb.shell(serial, ["dumpsys", "power"], { timeoutMs: 15_000 }).catch(() => "");
    this.screenOff = /mWakefulness\s*=\s*Asleep/i.test(powerOut);

    const notes: string[] = [
      "Semantic actions re-dump uiautomator and tap element centers; uiautomator over plain adb has no remote method invocation.",
      this.unicodeInput
        ? `ADBKeyboard IME detected (${ADB_KEYBOARD_IME}) — Unicode/CJK typing via am broadcast; the adapter switches IME while typing.`
        : `ADBKeyboard IME not installed — \`input text\` is ASCII-only. Install ${ADB_KEYBOARD_PKG} for Unicode/CJK input.`,
      "Clipboard access and window management are not exposed over plain adb; the window list is limited to the focused activity.",
    ];
    if (this.screenOff) {
      notes.push("Device screen is off (dumpsys power mWakefulness=Asleep); taps/screencap may fail until woken (`input keyevent 224`).");
    }
    if (!density) notes.push("wm density unparsable — assuming 160dpi (scale 1).");

    this.caps = {
      screenshot: true,
      accessibility: true, // uiautomator dump; verified on first use, see dumpVerified
      dom: false,
      globalInput: true,
      windowControl: false,
      appControl: true,
      clipboard: false,
      multiDisplay: false,
      notes,
    };

    this.info = {
      id: `android:${serial}`,
      platform: "android",
      type: "device",
      deviceId: serial,
      name: dev.model ? dev.model.replace(/_/g, " ") : serial,
      details: {
        state: dev.state,
        adb: this.adb.resolvedPath,
        screen: { ...this.screen, scale: this.densityScale() },
        unicodeInput: this.unicodeInput,
        screenOff: this.screenOff,
      },
    };
    return this.info;
  }

  /**
   * Device selection rules: explicit deviceId wins (validated by state);
   * otherwise exactly one online device is auto-selected; multiple online
   * devices without deviceId → invalid_request listing the serials.
   */
  private selectDevice(devices: AdbDevice[]): string {
    const wanted = this.opts.deviceId;
    if (wanted) {
      const dev = devices.find((d) => d.serial === wanted);
      if (!dev) {
        throw new ComputerUseError("device_not_found", `Device "${wanted}" is not attached`, {
          hint: `Attached: ${devices.map((d) => d.serial).join(", ") || "none"}`,
        });
      }
      if (dev.state === "offline") {
        throw new ComputerUseError("device_offline", `Device "${wanted}" is offline`, {
          hint: "Wake or re-plug the device, then retry.",
        });
      }
      if (dev.state === "unauthorized") {
        throw new ComputerUseError("permission_required", `Device "${wanted}" is unauthorized for adb debugging`, {
          hint: "Accept the 'Allow USB debugging' RSA dialog on the device screen (re-plug the cable to re-trigger it).",
        });
      }
      return wanted;
    }
    const online = devices.filter((d) => d.state === "device");
    if (online.length === 1) return online[0]!.serial;
    if (online.length > 1) {
      throw new ComputerUseError(
        "invalid_request",
        `Multiple devices attached (${online.map((d) => d.serial).join(", ")}) — pass deviceId`,
        { hint: "Pick a serial from `adb devices -l` and set Target.deviceId." },
      );
    }
    const unauthorized = devices.filter((d) => d.state === "unauthorized");
    if (unauthorized.length > 0) {
      throw new ComputerUseError(
        "permission_required",
        `No online device; ${unauthorized.map((d) => d.serial).join(", ")} unauthorized for adb debugging`,
        { hint: "Accept the 'Allow USB debugging' RSA dialog on the device screen." },
      );
    }
    const offline = devices.filter((d) => d.state === "offline");
    if (offline.length > 0) {
      throw new ComputerUseError("device_offline", `No online device; ${offline.map((d) => d.serial).join(", ")} offline`, {
        hint: "Wake or re-plug the device.",
      });
    }
    throw new ComputerUseError("device_not_found", "No Android devices attached", {
      hint: "Connect a device with USB debugging enabled (or start an emulator).",
    });
  }

  async close(): Promise<void> {}

  private requireOpen(): TargetInfo {
    if (!this.info) throw new ComputerUseError("invalid_request", "AndroidAdapter not open — call open() first");
    return this.info;
  }

  getTargetInfo(): TargetInfo {
    return this.requireOpen();
  }

  getCapabilities(): Capabilities {
    return this.caps;
  }

  // ---------------------------------------------------------------- geometry

  private densityScale(): number {
    return this.screen.density / 160;
  }

  private orientationFromRotation(): "portrait" | "landscape" {
    return this.screen.rotation % 2 === 1 ? "landscape" : "portrait";
  }

  private screenInfo(): ScreenInfo {
    const scale = this.densityScale();
    return {
      displays: [
        {
          id: "0",
          x: 0,
          y: 0,
          width: Math.max(1, Math.round(this.screen.width / scale)),
          height: Math.max(1, Math.round(this.screen.height / scale)),
          scale,
          primary: true,
        },
      ],
      orientation: this.orientationFromRotation(),
      width: Math.max(1, Math.round(this.screen.width / scale)),
      height: Math.max(1, Math.round(this.screen.height / scale)),
    };
  }

  /** Action point → physical pixels. Default space is physical. */
  private pointFromAction(p: PointInSpace): { x: number; y: number } {
    const space = p.space ?? "physical";
    if (space === "physical" || space === "screenshot") return { x: p.x, y: p.y };
    if (space === "logical") {
      const s = this.densityScale();
      return { x: p.x * s, y: p.y * s };
    }
    // normalized [0,1000] over the physical screen
    return { x: (p.x / 1000) * this.screen.width, y: (p.y / 1000) * this.screen.height };
  }

  // ---------------------------------------------------------------- observation

  async observe(options: ObserveOptions = {}): Promise<Observation> {
    const info = this.requireOpen();
    await this.refreshScreen();
    const screen = this.screenInfo();
    const shot = options.includeScreenshot === false ? undefined : await this.screenshot().catch(() => undefined);
    const activeApp = await this.topActivity().catch(() => undefined);
    let uiTree: UINode | undefined;
    if (options.includeUITree !== false) {
      try {
        uiTree = (await this.dumpTree()) ?? undefined;
      } catch {
        uiTree = undefined; // honest absence; capabilities stay as probed
      }
    }
    return {
      target: info,
      screen,
      screenshot: shot,
      activeApp,
      uiTree,
      capabilities: this.caps,
      capturedAt: Date.now(),
    };
  }

  private async refreshScreen(): Promise<void> {
    const size = await this.adb.shell(this.serial, ["wm", "size"], { timeoutMs: 10_000 });
    const parsed = parseWmSize(size);
    if (parsed) {
      this.screen.width = parsed.width;
      this.screen.height = parsed.height;
    }
    const density = parseWmDensity(await this.adb.shell(this.serial, ["wm", "density"], { timeoutMs: 10_000 }).catch(() => ""));
    if (density) this.screen.density = density;
    const rotOut = await this.adb
      .shell(this.serial, ["settings", "get", "system", "user_rotation"], { timeoutMs: 10_000 })
      .catch(() => "");
    const rot = Number.parseInt(rotOut, 10);
    if (Number.isFinite(rot) && rot >= 0 && rot <= 3) this.screen.rotation = rot;
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<Screenshot> {
    const info = this.requireOpen();
    const res = await this.adb.device(this.serial, ["exec-out", "screencap", "-p"], { timeoutMs: 30_000, binary: true });
    const raw = res.stdoutBuffer;
    if (raw.length < 8) {
      throw new ComputerUseError("internal_error", "screencap returned no image data", {
        hint: this.screenOff ? "The screen is off — wake it first (`input keyevent 224`)." : undefined,
      });
    }
    const shot = processScreenshot(
      raw,
      {
        targetId: info.id,
        scale: this.densityScale(),
        origin: { x: 0, y: 0 },
        orientation: this.orientationFromRotation(),
      },
      this.opts.screenshot,
    );
    // The image itself is the ground truth for orientation (rotation setting
    // can lag); the aspect ratio is preserved by downscaling.
    const imageOrientation: Orientation = shot.width >= shot.height ? "landscape" : "portrait";
    const fixed: Screenshot = imageOrientation === shot.orientation ? shot : { ...shot, orientation: imageOrientation };

    if (!options.region) return fixed;
    // ROI crop in physical pixels (screenshot space == physical on Android)
    const img = decodeImage(raw);
    const cropped = cropImage(img, options.region);
    return {
      format: "png",
      dataBase64: encodePng(cropped).toString("base64"),
      width: cropped.width,
      height: cropped.height,
      scale: fixed.scale,
      origin: { x: options.region.x, y: options.region.y },
      orientation: fixed.orientation,
      hash: averageHash(cropped),
      capturedAt: Date.now(),
      targetId: info.id,
    };
  }

  /**
   * FRESH uiautomator dump → UINode tree. Always re-dumps (never serves a
   * cached tree) so actions resolve against current screen state.
   */
  private async dumpTree(): Promise<UINode | null> {
    const d = await this.adb.device(this.serial, ["shell", "uiautomator", "dump", DUMP_PATH], { timeoutMs: 30_000 });
    const out = `${d.stdout}\n${d.stderr}`;
    if (/ERROR|could not get idle state/i.test(out) && !/dumped to/i.test(out)) {
      throw new ComputerUseError("internal_error", `uiautomator dump failed: ${out.trim().slice(0, 200)}`, {
        hint: "uiautomator can fail while animations run or when the screen is off; retry after the UI settles.",
      });
    }
    const cat = await this.adb.device(this.serial, ["shell", "cat", DUMP_PATH], { timeoutMs: 15_000 });
    const root = parseDump(cat.stdout);
    if (!root) {
      throw new ComputerUseError("internal_error", `uiautomator dump unreadable: ${cat.stdout.trim().slice(0, 160)}`, {
        hint: "The device produced no hierarchy; retry.",
      });
    }
    this.dumpVerified = true;
    return root;
  }

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
    this.requireOpen();
    const root = await this.dumpTree();
    if (!root) return null;
    const q: DumpQuery = {};
    if (descriptor.resourceId) q.resourceId = descriptor.resourceId;
    else if (descriptor.testId) q.resourceId = descriptor.testId; // Android convention: testId == resource id
    if (descriptor.text) q.text = descriptor.text;
    if (descriptor.name) q.name = descriptor.name;
    if (descriptor.role) q.role = descriptor.role;
    if (descriptor.css || descriptor.xpath) {
      // no CSS/XPath engine over plain adb — unsupported unless other criteria exist
      if (Object.keys(q).length === 0) return null;
    }
    if (Object.keys(q).length === 0) return null;
    const nodes = findBy(root, q);
    const pick = nodes[descriptor.index ?? 0] ?? null;
    if (!pick) return null;
    return { element: toElementRef(pick) };
  }

  // ---------------------------------------------------------------- actions

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
    this.requireOpen();
    switch (action.type) {
      case "click":
      case "invoke": {
        if (action.element) {
          const node = await this.resolveElement(action.element);
          const c = this.tapTarget(node);
          await this.tapXY(c.x, c.y);
          return { ok: true, method: "semantic", element: toElementRef(node), point: c };
        }
        const pt = action.type === "click" ? action.point : undefined;
        if (pt) {
          const p = this.pointFromAction(pt);
          await this.tapXY(p.x, p.y);
          return { ok: true, method: "coordinate", point: p };
        }
        throw new ComputerUseError("invalid_request", "click requires element or point");
      }
      case "double_click": {
        const p = await this.requirePoint(action.element, action.point);
        await this.tapXY(p.x, p.y);
        await this.tapXY(p.x, p.y);
        return { ok: true, method: action.element ? "semantic" : "coordinate", element: action.element, point: p };
      }
      case "long_press": {
        const p = await this.requirePoint(action.element, action.point);
        await this.swipe(p.x, p.y, p.x, p.y, action.durationMs ?? 800);
        return { ok: true, method: action.element ? "semantic" : "coordinate", element: action.element, point: p };
      }
      case "right_click":
        throw unsupported("right_click", "touch screens have no right click");
      case "move": {
        const p = this.pointFromAction(action.point);
        return { ok: true, method: "coordinate", point: p, detail: "hover has no effect on touch devices (no-op)" };
      }
      case "drag":
      case "swipe": {
        if (!action.from || !action.to) throw new ComputerUseError("invalid_request", `${action.type} requires from+to`);
        const from = await this.endpoint(action.from);
        const to = await this.endpoint(action.to);
        await this.swipe(from.x, from.y, to.x, to.y, action.durationMs ?? 400);
        return {
          ok: true,
          method: action.from.element || action.to.element ? "semantic" : "coordinate",
          element: action.from.element ?? action.to.element,
          point: to,
        };
      }
      case "scroll": {
        const anchor = action.element
          ? this.tapTarget(await this.resolveElement(action.element))
          : action.point
            ? this.pointFromAction(action.point)
            : { x: Math.round(this.screen.width / 2), y: Math.round(this.screen.height / 2) };
        const max = Math.round(Math.min(this.screen.width, this.screen.height) / 2);
        const d = Math.min(Math.max(Math.round((Math.min(this.screen.width, this.screen.height) / 6) * (action.amount ?? 3)), 60), max);
        const dir = action.direction;
        const from = { x: anchor.x + (dir === "left" ? d : dir === "right" ? -d : 0), y: anchor.y + (dir === "up" ? -d : dir === "down" ? d : 0) };
        const to = { x: anchor.x - (from.x - anchor.x), y: anchor.y - (from.y - anchor.y) };
        await this.swipe(from.x, from.y, to.x, to.y, 300);
        return { ok: true, method: "coordinate", point: to, detail: `scroll ${dir} ~${d}px` };
      }
      case "type": {
        if (action.element) {
          const node = await this.resolveElement(action.element);
          const c = this.tapTarget(node);
          await this.tapXY(c.x, c.y);
          await this.settle();
        }
        await this.typeText(action.text);
        if (action.submit) await this.keyevent(66);
        return { ok: true, method: action.element ? "semantic" : "coordinate", element: action.element };
      }
      case "set_value": {
        const node = await this.resolveElement(action.element);
        if (!node.editable && node.role !== "textfield") {
          throw new ComputerUseError("invalid_request", `Element "${node.name ?? node.id}" is not editable (class=${node.attributes?.class})`, {
            hint: "set_value targets EditText fields on Android.",
          });
        }
        const c = this.tapTarget(node);
        await this.tapXY(c.x, c.y);
        await this.settle();
        await this.clearText((node.value ?? "").length);
        await this.typeText(action.value);
        return { ok: true, method: "semantic", element: toElementRef(node) };
      }
      case "clear": {
        if (action.element) {
          const node = await this.resolveElement(action.element);
          const c = this.tapTarget(node);
          await this.tapXY(c.x, c.y);
          await this.settle();
          await this.clearText((node.value ?? "").length);
          return { ok: true, method: "semantic", element: toElementRef(node) };
        }
        await this.clearText(0);
        return { ok: true, method: "coordinate", detail: "cleared focused field" };
      }
      case "press": {
        const key = action.key.toLowerCase();
        const code = KEYCODES[key] ?? (/^\d+$/.test(action.key) ? Number(action.key) : undefined);
        if (code === undefined) {
          throw unsupported(`press "${action.key}"`, "no Android KEYCODE mapping — use a known name (enter/back/del/app_switch/…) or a numeric KEYCODE");
        }
        await this.keyevent(code);
        return { ok: true, method: "system", detail: `keyevent ${code}` };
      }
      case "hotkey":
        throw unsupported("hotkey", "Android `input` has no modifier combos — use press with single keys");
      case "select": {
        const node = await this.resolveElement(action.element);
        const c = this.tapTarget(node);
        await this.tapXY(c.x, c.y); // open the spinner/dropdown
        await this.settle();
        if (action.value !== undefined) {
          const root = await this.dumpTree();
          if (!root) throw new ComputerUseError("element_not_found", `Option "${action.value}": no dump available`);
          const options = findBy(root, { text: action.value });
          const opt = options[action.index ?? 0] ?? null;
          if (!opt) {
            throw new ComputerUseError("element_not_found", `Option "${action.value}" not visible after opening the selector`, {
              hint: "Scroll the list open and retry, or use vision coordinates.",
            });
          }
          const oc = this.tapTarget(opt);
          await this.tapXY(oc.x, oc.y);
        }
        return {
          ok: true,
          method: "semantic",
          element: toElementRef(node),
          detail: action.value === undefined && action.index === undefined ? "opened selector; pass value to pick an option" : undefined,
        };
      }
      case "toggle": {
        const node = await this.resolveElement(action.element);
        if (action.value !== undefined && node.checked === action.value) {
          return { ok: true, method: "semantic", element: toElementRef(node), detail: "already in requested state" };
        }
        const c = this.tapTarget(node);
        await this.tapXY(c.x, c.y);
        return {
          ok: true,
          method: "semantic",
          element: toElementRef(node),
          point: c,
          detail: "uiautomator over adb has no remote invoke — toggle executed as tap at element center",
        };
      }
      case "focus": {
        if (action.app) {
          await this.launchApp(action.app);
          return { ok: true, method: "system" };
        }
        if (action.windowTitle) {
          throw unsupported("focus by windowTitle", "Android exposes no window titles over adb — use the app package");
        }
        throw new ComputerUseError("invalid_request", "focus requires app (package name)");
      }
      case "launch_app":
        await this.launchApp(action.app);
        return { ok: true, method: "system" };
      case "terminate_app":
        await this.terminateApp(action.app);
        return { ok: true, method: "system" };
      case "back":
        await this.keyevent(4); // KEYCODE_BACK
        return { ok: true, method: "system" };
      case "home":
        await this.keyevent(3); // KEYCODE_HOME
        return { ok: true, method: "system" };
      case "wait":
        await new Promise((r) => setTimeout(r, action.durationMs));
        return { ok: true, method: "system" };
      case "finish":
      case "fail":
        return { ok: true, method: "system", detail: action.type };
      default:
        throw new ComputerUseError("invalid_request", "unhandled action type");
    }
  }

  /**
   * Resolve an ElementRef against a FRESH dump (structured-first contract):
   * 1) stable path id; 2) identity re-match by resource-id / value /
   * content-desc when the tree shifted; 3) bare path as last resort.
   */
  private async resolveElement(el: ElementRef): Promise<UINode> {
    if (el.source !== "uiautomator" && !el.id.startsWith("uia:")) {
      throw new ComputerUseError("invalid_request", `Element ${el.id} (source=${el.source}) does not belong to the Android adapter`);
    }
    const root = await this.dumpTree();
    if (!root) throw new ComputerUseError("element_not_found", `Element ${el.id}: no dump available`);
    const path = el.id.startsWith("uia:") ? el.id.slice(4) : el.id;
    const byPath = resolveNode(root, path);
    if (byPath && nodeStillMatches(byPath, el)) return byPath;

    // Identity fallback by stable attributes
    const rid = el.attributes?.["resource-id"];
    if (typeof rid === "string" && rid) {
      const byId = findBy(root, { resourceId: rid });
      if (byId.length > 0) return byId[0]!;
    }
    const descQuery = el.description ? findBy(root, { contentDesc: el.description }) : [];
    if (descQuery.length > 0) return descQuery[0]!;
    const textQuery = el.value ? findBy(root, { text: el.value }) : [];
    if (textQuery.length > 0) return textQuery[0]!;

    if (byPath) return byPath; // path exists but nothing to verify against
    throw new ComputerUseError("element_not_found", `Element ${el.id} (${el.name ?? "unnamed"}) not found in fresh uiautomator dump`, {
      hint: "Re-observe: the screen content changed since the element was captured.",
    });
  }

  private tapTarget(node: UINode): { x: number; y: number } {
    if (!node.bounds) {
      throw new ComputerUseError("element_not_found", `Element ${node.id} has no bounds in the dump`);
    }
    return centerOf(node.bounds);
  }

  private async requirePoint(
    el: ElementRef | undefined,
    pt: PointInSpace | undefined,
  ): Promise<{ x: number; y: number }> {
    if (pt) return this.pointFromAction(pt);
    if (el) {
      const node = await this.resolveElement(el);
      return this.tapTarget(node);
    }
    throw new ComputerUseError("invalid_request", "No usable element or point for pointer action");
  }

  private async endpoint(t: { element?: ElementRef; point?: PointInSpace }): Promise<{ x: number; y: number }> {
    if (t.point) return this.pointFromAction(t.point);
    if (t.element) {
      const node = await this.resolveElement(t.element);
      return this.tapTarget(node);
    }
    throw new ComputerUseError("invalid_request", "drag/swipe endpoints need point or element");
  }

  private async settle(): Promise<void> {
    const ms = this.opts.settleMs ?? 400;
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  }

  // ---------------------------------------------------------------- input primitives

  private async tapXY(x: number, y: number): Promise<void> {
    await this.adb.device(this.serial, ["shell", "input", "tap", String(Math.round(x)), String(Math.round(y))], { timeoutMs: 15_000 });
  }

  private async swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void> {
    await this.adb.device(
      this.serial,
      ["shell", "input", "swipe", String(Math.round(x1)), String(Math.round(y1)), String(Math.round(x2)), String(Math.round(y2)), String(Math.round(durationMs))],
      { timeoutMs: 20_000 },
    );
  }

  private async keyevent(...codes: number[]): Promise<void> {
    await this.adb.device(this.serial, ["shell", "input", "keyevent", ...codes.map(String)], { timeoutMs: 15_000 });
  }

  /**
   * Unicode via ADBKeyboard broadcast when installed (probed at open);
   * otherwise `input text`, which splits on spaces — encode them as %s.
   */
  private async typeText(text: string): Promise<void> {
    if (this.unicodeInput) {
      await this.adb.shell(this.serial, ["ime", "set", ADB_KEYBOARD_IME], { timeoutMs: 10_000 }).catch(() => {});
      await this.adb.device(
        this.serial,
        ["shell", "am", "broadcast", "-a", "ADB_INPUT_TEXT", "--es", "msg", quoteDeviceArg(text)],
        { timeoutMs: 15_000 },
      );
      return;
    }
    await this.adb.device(this.serial, ["shell", "input", "text", quoteDeviceArg(text.replace(/ /g, "%s"))], { timeoutMs: 15_000 });
  }

  /** Move to field end (KEYCODE_MOVE_END) then DEL the existing content. */
  private async clearText(currentLen: number): Promise<void> {
    await this.keyevent(123);
    const dels = Math.min(Math.max(currentLen + 2, 8), 160);
    const codes = Array.from({ length: dels }, () => 67);
    for (let i = 0; i < codes.length; i += 20) {
      await this.keyevent(...codes.slice(i, i + 20));
    }
  }

  // ---------------------------------------------------------------- apps / windows

  async listApps(): Promise<AppInfo[]> {
    this.requireOpen();
    const out = await this.adb.shell(this.serial, ["pm", "list", "packages", "-3"], { timeoutMs: 15_000 });
    const top = await this.topActivity().catch(() => undefined);
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("package:"))
      .map((l) => l.slice("package:".length))
      .filter(Boolean)
      .map((pkg) => ({
        name: pkg,
        identifier: pkg,
        frontmost: top?.identifier === pkg,
        context: top?.identifier === pkg ? top.context : undefined,
      }));
  }

  /** Android has one focused surface — the resumed activity. */
  async listWindows(): Promise<WindowInfo[]> {
    this.requireOpen();
    const top = await this.topActivity().catch(() => undefined);
    if (!top) return [];
    return [
      {
        id: top.context ?? top.name,
        title: top.name,
        app: top.identifier,
        focused: true,
      },
    ];
  }

  /** Parse the resumed activity from `dumpsys activity activities`. */
  private async topActivity(): Promise<AppInfo | undefined> {
    const out = await this.adb.shell(this.serial, ["dumpsys", "activity", "activities"], { timeoutMs: 15_000 });
    const m = out.match(/(?:topResumedActivity=|mResumedActivity:)\s*ActivityRecord\{[^}]*?\s([\w.$]+)\/([^\s}]+)/);
    if (!m) return undefined;
    const pkg = m[1]!;
    const act = m[2]!;
    return {
      name: act.replace(/^\./, "").split(".").pop() ?? act,
      identifier: pkg,
      context: `${pkg}/${act}`,
      frontmost: true,
    };
  }

  async launchApp(app: string, _options: LaunchOptions = {}): Promise<void> {
    this.requireOpen();
    if (app.includes("/")) {
      // fully-qualified component: pkg/activity
      await this.adb.shell(this.serial, ["am", "start", "-n", app], { timeoutMs: 20_000 });
      return;
    }
    const r = await this.adb.device(
      this.serial,
      ["shell", "monkey", "-p", app, "-c", "android.intent.category.LAUNCHER", "1"],
      { timeoutMs: 20_000 },
    );
    if (r.code !== 0 || /No activities found|Error type/i.test(r.stdout + r.stderr)) {
      throw new ComputerUseError("element_not_found", `No launcher activity found for package "${app}"`, {
        hint: "Use the full package name (list via `adb shell pm list packages -3`) or pkg/activity with am start.",
      });
    }
  }

  async terminateApp(app: string): Promise<void> {
    this.requireOpen();
    await this.adb.shell(this.serial, ["am", "force-stop", app], { timeoutMs: 15_000 });
  }

  async focusTarget(options: { app?: string; windowTitle?: string }): Promise<void> {
    this.requireOpen();
    if (options.app) {
      await this.launchApp(options.app);
      return;
    }
    throw unsupported("focus by windowTitle", "Android exposes no window titles over adb — use the app package");
  }
}

/**
 * Cheap availability probe for the router (never throws):
 * available = adb found AND ≥1 device in state "device".
 */
export async function androidProbe(
  opts: { adbPath?: string; exec?: AdbExecFn; discover?: () => string | null } = {},
): Promise<{ available: boolean; reason?: string; details?: Record<string, unknown> }> {
  try {
    const client = new AdbClient(opts);
    const devices = await client.devices();
    const online = devices.filter((d) => d.state === "device");
    if (online.length > 0) {
      return {
        available: true,
        details: {
          adb: client.resolvedPath,
          devices: online.map((d) => ({ serial: d.serial, model: d.model })),
          others: devices.filter((d) => d.state !== "device").map((d) => ({ serial: d.serial, state: d.state })),
        },
      };
    }
    const unauthorized = devices.filter((d) => d.state === "unauthorized");
    if (unauthorized.length > 0) {
      return {
        available: false,
        reason: `device(s) ${unauthorized.map((d) => d.serial).join(", ")} unauthorized — accept the RSA debugging dialog on the device screen`,
        details: { devices: devices.map((d) => ({ serial: d.serial, state: d.state })) },
      };
    }
    const offline = devices.filter((d) => d.state === "offline");
    if (offline.length > 0) {
      return {
        available: false,
        reason: `device(s) ${offline.map((d) => d.serial).join(", ")} offline`,
        details: { devices: devices.map((d) => ({ serial: d.serial, state: d.state })) },
      };
    }
    return { available: false, reason: "no Android devices attached" };
  } catch (e) {
    return { available: false, reason: (e as Error).message };
  }
}
