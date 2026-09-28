/**
 * Linux PlatformAdapter — X11 first-class, Wayland honest (spec §5/§33).
 *
 * X11 backend (all tools probed with `which` before use):
 *   screenshot      import (ImageMagick) | scrot | gnome-screenshot -f
 *   windows         wmctrl -l -G / -a / -c
 *   input           xdotool (mousemove/click/drag chain/scroll via buttons 4-7/key/type)
 *   accessibility   AT-SPI2 via python3+pyatspi (see ./atspi.ts)
 *
 * Wayland backend: only what tools actually allow — grim capture, wtype /
 * ydotool(+ydotoold) input, AT-SPI semantic actions. Everything else throws
 * ComputerUseError("restricted") with actionable hints. Never faked.
 *
 * Coordinate space: X screen pixels, origin (0,0), scale 1. The screenshot
 * pixel space equals the logical space; fractional scaling is NOT compensated
 * (documented in capabilities.notes).
 *
 * Element identity: "atspi:<appIdx>/<childIdx>/…" paths resolved by the
 * embedded pyatspi walker; actions are structured-first (Action.doAction /
 * Text.setTextContents) with an xdotool coordinate fallback on X11 only.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Capabilities,
  type AppInfo,
  type ElementRef,
  type Observation,
  type PointInSpace,
  type ScreenInfo,
  type Screenshot,
  type TargetInfo,
  type UINode,
  type WindowInfo,
} from "../../core/types.js";
import type { Action, ActionResult } from "../../core/types-action.js";
import { ComputerUseError, restricted, unsupported } from "../../core/errors.js";
import { processScreenshot } from "../../screenshot/pipeline.js";
import type { ProcessOptions } from "../../screenshot/pipeline.js";
import type { ObserveOptions, PlatformAdapter, ScreenshotOptions, LaunchOptions } from "../adapter.js";
import {
  defaultExec,
  probeLinux,
  type ExecFn,
  type LinuxDetection,
  type LinuxEnv,
  type SessionDetection,
} from "./session.js";
import * as x11 from "./x11.js";
import * as atspi from "./atspi.js";
import * as wayland from "./wayland.js";

export interface LinuxAdapterDeps {
  /** execution seam (defaults to platforms/exec.ts run) */
  exec?: ExecFn;
  /** environment seam (defaults to process.env) */
  env?: LinuxEnv;
  /** host check seam (defaults to process.platform) */
  hostPlatform?: NodeJS.Platform;
  /** screenshot post-processing options */
  screenshot?: ProcessOptions;
  /** AT-SPI walker limits */
  atspiTree?: { maxDepth?: number; maxNodes?: number };
}

export interface TargetProbe {
  available: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

const INSTALL_HINTS = {
  xdotool: "sudo apt install xdotool (or dnf/pacman equivalent)",
  wmctrl: "sudo apt install wmctrl",
  screenshot: "sudo apt install scrot, imagemagick (provides import), or gnome-screenshot",
  xclip: "sudo apt install xclip (or xsel)",
  pyatspi: "sudo apt install at-spi2-core python3-pyatspi",
  launcher: "install gtk-launch (GTK) or gio (glib)",
};

/**
 * Honest capability matrix from detection results (pure; unit-tested).
 * Every true is backed by a probed tool — nothing is assumed.
 */
export function buildCapabilities(detection: LinuxDetection): Capabilities {
  const t = detection.tools;
  const notes: string[] = [];
  const accessibility = detection.python3 && detection.pyatspi;

  if (detection.session.session === "wayland") {
    const grim = !!t.grim;
    const wtype = !!t.wtype;
    const ydotool = !!t.ydotool;
    const ydotoold = !!t.ydotoold;
    const screenshot = grim;
    const globalInput = wtype || ydotool;
    const appControl = !!(t["gtk-launch"] || t.gio);
    const clipboard = !!t["wl-copy"];

    notes.push(
      `Wayland session (${detection.session.compositor}): the compositor security model blocks global capture/injection; only the detected tools actually work.`,
    );
    if (!grim) {
      notes.push(
        "No grim: screenshot unavailable. xdg-desktop-portal's org.freedesktop.portal.Screenshot exists but requires interactive user consent per capture.",
      );
    }
    if (globalInput && ydotool && !ydotoold) {
      notes.push(
        "ydotool found but its ydotoold daemon was not detected: synthetic input will fail until ydotoold runs with /dev/uinput access (input group).",
      );
    }
    if (!wtype && !ydotool) {
      notes.push("No wtype/ydotool: global keyboard and pointer input are unavailable on this Wayland session.");
    }
    notes.push("Window listing/focus/close is compositor-specific on Wayland and not supported by this adapter.");
    if (accessibility) {
      notes.push("AT-SPI semantic actions (press/toggle/set text) work via the accessibility bus; coordinate fallback needs synthetic input.");
    } else {
      notes.push(`AT-SPI tree unavailable (python3/pyatspi missing): ${INSTALL_HINTS.pyatspi}`);
    }
    return {
      screenshot,
      accessibility,
      dom: false,
      globalInput,
      windowControl: false,
      appControl,
      clipboard,
      multiDisplay: false,
      notes,
    };
  }

  // ---- X11 ----
  const screenshot = !!(t.import || t.scrot || t["gnome-screenshot"]);
  const globalInput = !!t.xdotool;
  const windowControl = !!t.wmctrl;
  const appControl = !!(t["gtk-launch"] || t.gio);
  const clipboard = !!(t.xclip || t.xsel);
  const multiDisplay = !!t.xrandr;

  notes.push(
    "X11: coordinate space is raw screen pixels, origin (0,0), scale 1 assumed; fractional scaling is not compensated and may shift coordinates.",
  );
  if (!screenshot) notes.push(`No capture tool (import/scrot/gnome-screenshot): screenshots disabled. ${INSTALL_HINTS.screenshot}`);
  if (!globalInput) notes.push(`xdotool not found: mouse/keyboard input disabled. ${INSTALL_HINTS.xdotool}`);
  if (!windowControl) notes.push(`wmctrl not found: window listing/focus/close disabled. ${INSTALL_HINTS.wmctrl}`);
  if (accessibility) {
    notes.push("AT-SPI2 structured tree enabled (python3 + pyatspi); actions are structured-first with xdotool coordinate fallback.");
  } else {
    notes.push(`AT-SPI2 tree unavailable (python3/pyatspi missing): semantic actions degraded to coordinates. ${INSTALL_HINTS.pyatspi}`);
  }
  if (!clipboard) notes.push(`xclip/xsel not found: clipboard disabled. ${INSTALL_HINTS.xclip}`);

  return {
    screenshot,
    accessibility,
    dom: false,
    globalInput,
    windowControl,
    appControl,
    clipboard,
    multiDisplay,
    notes,
  };
}

interface ResolvedAtspi {
  path: string;
  app?: string;
  bounds?: { x: number; y: number; width: number; height: number };
}

export class LinuxAdapter implements PlatformAdapter {
  readonly platform = "linux";
  private readonly exec: ExecFn;
  private readonly env: LinuxEnv;
  private readonly hostPlatform: NodeJS.Platform;
  private readonly shotOpts: ProcessOptions | undefined;
  private readonly treeDepth: number;
  private readonly treeNodes: number;

  private detection!: LinuxDetection;
  private session!: SessionDetection;
  private info!: TargetInfo;
  private caps!: Capabilities;
  /** last known full-screen pixel size (from xrandr/xdotool/screenshots) */
  private screen = { width: 0, height: 0 };
  private lastTree: atspi.AtspiNode[] = [];
  /** decimal xdotool window id of the active window */
  private activeWindowId: string | null = null;

  constructor(deps: LinuxAdapterDeps = {}) {
    this.exec = deps.exec ?? defaultExec;
    this.env = deps.env ?? process.env;
    this.hostPlatform = deps.hostPlatform ?? process.platform;
    this.shotOpts = deps.screenshot;
    this.treeDepth = deps.atspiTree?.maxDepth ?? 12;
    this.treeNodes = deps.atspiTree?.maxNodes ?? 400;
  }

  get isWayland(): boolean {
    return this.session?.session === "wayland";
  }

  async open(): Promise<TargetInfo> {
    if (this.hostPlatform !== "linux") {
      throw unsupported("linux adapter", `requires a linux host, got ${this.hostPlatform}`);
    }
    this.detection = await probeLinux(this.exec, this.env);
    this.session = this.detection.session;
    if (this.session.session !== "x11" && this.session.session !== "wayland") {
      throw new ComputerUseError("restricted", "No graphical session detected", {
        details: { xdgSessionType: this.env.XDG_SESSION_TYPE ?? null, display: this.env.DISPLAY ?? null },
        hint: "Run the MCP inside an X11 (DISPLAY set) or Wayland (WAYLAND_DISPLAY set) login session.",
      });
    }
    this.caps = buildCapabilities(this.detection);
    const where = this.session.session === "wayland" ? `Wayland/${this.session.compositor}` : "X11";
    this.info = {
      id: "local:linux",
      platform: "linux",
      type: "local",
      name: `Local Linux (${where})`,
      details: {
        session: this.session.session,
        desktop: this.session.desktop,
        compositor: this.session.compositor,
        tools: this.detection.tools,
        pyatspi: this.detection.pyatspi,
      },
    };
    return this.info;
  }

  async close(): Promise<void> {}

  getTargetInfo(): TargetInfo {
    return this.info;
  }

  getCapabilities(): Capabilities {
    return this.caps;
  }

  // -------------------------------------------------------------------------
  // Screenshots
  // -------------------------------------------------------------------------

  async screenshot(options: ScreenshotOptions = {}): Promise<Screenshot> {
    if (!this.caps.screenshot) {
      if (this.isWayland) throw wayland.waylandScreenshotError();
      throw restricted(
        "screenshot",
        "no capture tool available (need import, scrot, or gnome-screenshot)",
        `Install one of: scrot, imagemagick (import), gnome-screenshot. ${INSTALL_HINTS.screenshot}`,
      );
    }
    return this.isWayland ? this.screenshotWayland(options) : this.screenshotX11(options);
  }

  private async captureToFile(cmd: string, args: string[]): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), "cumcp-linux-"));
    const file = join(dir, "screen.png");
    try {
      const r = await this.exec(cmd, [...args, file], 15_000);
      if (r.code !== 0) {
        throw new ComputerUseError("provider_error", `${cmd} failed: ${(r.stderr || r.stdout || `exit ${r.code}`).trim().slice(0, 300)}`);
      }
      return await readFile(file);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async screenshotFrom(raw: Buffer, origin: { x: number; y: number }, fullCapture: boolean): Promise<Screenshot> {
    const size = x11.readPngSize(raw); // throws provider_error when not PNG
    if (fullCapture && size.width > 0) this.screen = size;
    return processScreenshot(
      raw,
      {
        targetId: this.info.id,
        scale: 1, // X11 pixel space == logical space (fractional scaling not compensated)
        origin,
        orientation: size.width >= size.height ? "landscape" : "portrait",
      },
      this.shotOpts,
    );
  }

  private async screenshotX11(options: ScreenshotOptions): Promise<Screenshot> {
    const tool = x11.pickScreenshotTool(this.detection.tools);
    if (!tool) {
      throw restricted("screenshot", "no capture tool available", INSTALL_HINTS.screenshot);
    }
    let target: x11.ScreenshotTarget = {};
    if (options.windowId) {
      const roi = this.boundsForElementId(options.windowId);
      if (roi) {
        target = { region: roi };
      } else if (/^(0x)?[0-9a-f]+$/i.test(options.windowId)) {
        if (tool !== "import") {
          throw restricted(`screenshot of window ${options.windowId}`, `tool "${tool}" cannot capture a window by id`, "Use ImageMagick `import` for window captures.");
        }
        target = { windowId: options.windowId };
      } else {
        throw new ComputerUseError("element_not_found", `No element/window found for windowId "${options.windowId}"`);
      }
    } else if (options.region) {
      target = { region: options.region };
    }
    const args = x11.buildScreenshotArgs(tool, target);
    if (args === null) {
      throw restricted(`screenshot of window ${options.windowId ?? ""}`.trim(), `tool "${tool}" cannot serve this capture target`, "Use import (ImageMagick) for window/region captures on X11.");
    }
    const raw = await this.captureToFile(tool, args);
    return this.screenshotFrom(raw, { x: target.region?.x ?? 0, y: target.region?.y ?? 0 }, !target.windowId && !target.region);
  }

  private async screenshotWayland(options: ScreenshotOptions): Promise<Screenshot> {
    if (!this.detection.tools.grim) throw wayland.waylandScreenshotError();
    if (options.windowId) {
      const roi = this.boundsForElementId(options.windowId);
      if (!roi) throw new ComputerUseError("unsupported", "grim cannot capture a window by id on Wayland", { hint: "Capture a region from element bounds instead." });
      const raw = await this.captureToFile("grim", wayland.buildGrimArgs(roi));
      return this.screenshotFrom(raw, { x: roi.x, y: roi.y }, false);
    }
    const raw = await this.captureToFile("grim", wayland.buildGrimArgs(options.region));
    return this.screenshotFrom(raw, { x: options.region?.x ?? 0, y: options.region?.y ?? 0 }, !options.region);
  }

  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------

  async observe(options: ObserveOptions = {}): Promise<Observation> {
    const screen = await this.getScreenInfo();
    const shot = options.includeScreenshot !== false ? await this.screenshot().catch(() => undefined) : undefined;
    let activeApp: AppInfo | undefined;
    let windows: WindowInfo[] | undefined;
    if (!this.isWayland) {
      activeApp = await this.frontmostApp().catch(() => undefined);
      windows = await this.listWindows().catch(() => []);
    }
    let uiTree: UINode | undefined;
    if (options.includeUITree !== false && this.caps.accessibility) {
      try {
        const nodes = await this.ensureTree(activeApp?.name);
        uiTree = atspi.atspiToTree(nodes) ?? undefined;
      } catch {
        // honest: no tree rather than a fabricated one
      }
    }
    return {
      target: this.info,
      screen,
      screenshot: shot,
      activeApp,
      uiTree,
      windows,
      capabilities: this.caps,
      capturedAt: Date.now(),
    };
  }

  private async getScreenInfo(): Promise<ScreenInfo> {
    if (!this.isWayland && this.detection.tools.xrandr) {
      try {
        const r = await this.exec("xrandr", ["--query"], 10_000);
        const monitors = x11.parseXrandrMonitors(r.stdout);
        if (monitors.length > 0) {
          const displays = monitors.map((m, i) => ({
            id: m.name,
            x: m.x,
            y: m.y,
            width: m.width,
            height: m.height,
            scale: 1, // pixel == logical on stock X11 (see notes for fractional scaling caveat)
            primary: m.primary || i === 0,
          }));
          const primary = displays.find((d) => d.primary) ?? displays[0]!;
          this.screen = { width: primary.width, height: primary.height };
          return {
            displays,
            orientation: primary.width >= primary.height ? "landscape" : "portrait",
            width: primary.width,
            height: primary.height,
          };
        }
      } catch {
        // fall through
      }
    }
    if (!this.isWayland && this.detection.tools.xdotool) {
      try {
        const r = await this.exec("xdotool", ["getdisplaygeometry"], 5_000);
        const g = x11.parseXdotoolDisplayGeometry(r.stdout);
        if (g) this.screen = g;
      } catch {
        // fall through
      }
    }
    const { width, height } = this.screen;
    return {
      displays: [{ id: "0", x: 0, y: 0, width, height, scale: 1, primary: true }],
      orientation: width >= height ? "landscape" : "portrait",
      width,
      height,
    };
  }

  private async getActiveWindowId(): Promise<string | null> {
    if (!this.detection.tools.xdotool) return null;
    try {
      const r = await this.exec("xdotool", ["getactivewindow"], 5_000);
      return x11.parseXdotoolWindowId(r.stdout);
    } catch {
      return null;
    }
  }

  private async frontmostApp(): Promise<AppInfo | undefined> {
    const id = (await this.getActiveWindowId()) ?? this.activeWindowId;
    if (!id) return undefined;
    this.activeWindowId = id;
    if (this.detection.tools.wmctrl) {
      const r = await this.exec("wmctrl", ["-l", "-x"], 10_000).catch(() => null);
      const entries = r ? x11.parseWmctrlListX(r.stdout) : [];
      const hex = x11.toWmctrlId(id);
      const match = entries.find((e) => e.id.toLowerCase() === hex.toLowerCase());
      if (match) {
        return {
          name: match.wmClass.split(".")[0] || match.wmClass,
          identifier: match.wmClass,
          frontmost: true,
          context: match.title,
        };
      }
    }
    const n = await this.exec("xdotool", ["getwindowname", id], 5_000).catch(() => null);
    return { name: n?.stdout.trim() || `window ${id}`, frontmost: true };
  }

  // -------------------------------------------------------------------------
  // AT-SPI structured access
  // -------------------------------------------------------------------------

  private async ensureTree(appName?: string): Promise<atspi.AtspiNode[]> {
    if (!this.caps.accessibility) {
      throw restricted("accessibility tree", "python3/pyatspi is not available", INSTALL_HINTS.pyatspi);
    }
    const r = await this.exec(
      "python3",
      atspi.buildAtspiWalkArgs({
        app: appName && !this.isWayland ? appName : undefined,
        maxDepth: this.treeDepth,
        maxNodes: this.treeNodes,
      }),
      30_000,
    );
    const { nodes, errors } = atspi.parseAtspiNodes(r.stdout);
    if (nodes.length === 0 && errors.length > 0) {
      throw restricted("accessibility tree", errors.join("; "));
    }
    this.lastTree = nodes;
    return nodes;
  }

  private async atspiAct(path: string): Promise<atspi.AtspiActionResult> {
    const r = await this.exec("python3", atspi.buildAtspiActArgs(path), 15_000);
    return atspi.parseAtspiResult(r.stdout);
  }

  private async atspiSetText(path: string, value: string): Promise<atspi.AtspiActionResult> {
    const r = await this.exec("python3", atspi.buildAtspiSetTextArgs(path, value), 15_000);
    return atspi.parseAtspiResult(r.stdout);
  }

  private tryResolveElement(el?: ElementRef): ResolvedAtspi | null {
    if (!el) return null;
    const path = el.id.startsWith("atspi:") ? el.id.slice("atspi:".length) : (el.attributes?.atspiPath as string | undefined);
    if (!path && el.source !== "atspi") return null;
    if (!path) return null;
    return {
      path,
      app: el.attributes?.app as string | undefined,
      bounds: el.bounds,
    };
  }

  private requireResolveElement(el: ElementRef): ResolvedAtspi {
    const r = this.tryResolveElement(el);
    if (!r) {
      throw new ComputerUseError("invalid_request", `Element ${el.id} does not belong to the Linux adapter (source=${el.source})`);
    }
    return r;
  }

  private boundsForElementId(idOrPath: string): { x: number; y: number; width: number; height: number } | null {
    const path = idOrPath.startsWith("atspi:") ? idOrPath.slice("atspi:".length) : idOrPath;
    const node = this.lastTree.find((n) => n.path === path);
    return node?.extents ?? null;
  }

  async locate(descriptor: {
    role?: string;
    name?: string;
    text?: string;
    index?: number;
  }): Promise<{ element: ElementRef } | null> {
    if (!this.caps.accessibility) return null;
    let nodes: atspi.AtspiNode[];
    try {
      nodes = await this.ensureTree();
    } catch {
      return null;
    }
    const wantName = (descriptor.name ?? descriptor.text ?? "").trim().toLowerCase();
    const wantRole = descriptor.role ? atspi.normalizeAtspiRole(descriptor.role) : null;
    const matches = nodes.filter((n) => {
      if (n.depth === 0) return false; // application roots are not actionable elements
      if (wantRole && atspi.normalizeAtspiRole(n.role) !== wantRole) return false;
      if (wantName && !n.name.toLowerCase().includes(wantName)) return false;
      return Boolean(wantName || wantRole);
    });
    const pick = matches[descriptor.index ?? 0];
    if (!pick) return null;
    const role = atspi.normalizeAtspiRole(pick.role);
    return {
      element: {
        id: `atspi:${pick.path}`,
        source: "atspi",
        role,
        name: pick.name || undefined,
        value: pick.text || undefined,
        description: pick.description || undefined,
        bounds: pick.extents ?? undefined,
        clickable: pick.actions.length > 0 || atspi.isClickableRole(role),
        editable: pick.states.editable,
        enabled: pick.states.enabled,
        checked: pick.states.checked,
        focused: pick.states.focused,
        attributes: { app: pick.app, atspiPath: pick.path, atspiRole: pick.role, actions: pick.actions.join(",") },
      },
    };
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

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

  private requireXdotool(what: string): void {
    if (!this.detection.tools.xdotool) {
      throw restricted(what, "xdotool not found", INSTALL_HINTS.xdotool);
    }
  }

  private requireWaylandPointer(what: string): boolean {
    if (!this.detection.tools.ydotool || !this.detection.tools.ydotoold) {
      throw wayland.waylandPointerError(what);
    }
    return true;
  }

  private requirePoint(
    action: Action,
    el: ElementRef | undefined,
    resolved: ResolvedAtspi | null | undefined,
  ): { x: number; y: number } {
    if ("point" in action && action.point) return this.pointFromAction(action.point);
    const b = resolved?.bounds ?? el?.bounds;
    if (b) return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    throw new ComputerUseError("invalid_request", "No usable element bounds or point for pointer action");
  }

  private async resolveEndpoint(t: { element?: ElementRef; point?: PointInSpace }): Promise<{ x: number; y: number }> {
    if (t.point) return this.pointFromAction(t.point);
    if (t.element?.bounds) {
      return { x: t.element.bounds.x + t.element.bounds.width / 2, y: t.element.bounds.y + t.element.bounds.height / 2 };
    }
    throw new ComputerUseError("invalid_request", "drag/swipe endpoints need a point or an element with bounds");
  }

  /** Accept points in any declared space; pixels (scale 1) are canonical. */
  private pointFromAction(p: PointInSpace): { x: number; y: number } {
    const space = p.space ?? "logical";
    if (space === "normalized") {
      if (this.screen.width > 0 && this.screen.height > 0) {
        return { x: (p.x / 1000) * this.screen.width, y: (p.y / 1000) * this.screen.height };
      }
      return { x: p.x, y: p.y };
    }
    // logical == screenshot == physical at scale 1
    return { x: p.x, y: p.y };
  }

  private async executeInner(action: Action): Promise<Omit<ActionResult, "durationMs">> {
    switch (action.type) {
      case "click":
      case "double_click":
      case "right_click":
      case "long_press":
        return this.actPointer(action);
      case "move":
        return this.isWayland ? this.waylandMove(action.point) : this.x11Move(action.point);
      case "drag":
      case "swipe": {
        if (!action.from || !action.to) throw new ComputerUseError("invalid_request", `${action.type} requires from+to`);
        const from = await this.resolveEndpoint(action.from);
        const to = await this.resolveEndpoint(action.to);
        if (this.isWayland) {
          this.requireWaylandPointer(action.type);
          await this.exec("ydotool", [
            ...wayland.buildYdotoolMouseMove(from.x, from.y),
            "mousemove",
            "-a",
            String(Math.round(to.x)),
            String(Math.round(to.y)),
            "click",
            wayland.YDOTOOOL_MOUSE_BUTTONS.left,
          ]);
          return { ok: true, method: "coordinate", point: to };
        }
        this.requireXdotool(action.type);
        await this.exec("xdotool", x11.buildDrag(from, to));
        return { ok: true, method: "coordinate", point: to };
      }
      case "scroll": {
        const anchor = action.point ? this.pointFromAction(action.point) : { x: this.screen.width / 2 || 640, y: this.screen.height / 2 || 512 };
        const amount = Math.max(1, Math.round(action.amount ?? 3));
        if (this.isWayland) {
          this.requireWaylandPointer("scroll");
          const dy = (action.direction === "up" ? -1 : action.direction === "down" ? 1 : 0) * amount * 40;
          const dx = (action.direction === "right" ? 1 : action.direction === "left" ? -1 : 0) * amount * 40;
          await this.exec("ydotool", wayland.buildYdotoolWheel(dx, dy));
          return { ok: true, method: "coordinate", point: anchor };
        }
        this.requireXdotool("scroll");
        await this.exec("xdotool", x11.buildScroll(anchor.x, anchor.y, action.direction, amount));
        return { ok: true, method: "coordinate", point: anchor };
      }
      case "type":
        return this.actType(action);
      case "set_value":
        return this.actSetValue(action.element, action.value);
      case "clear":
        return this.actSetValue(action.element, "");
      case "press":
        return this.isWayland ? this.waylandKey(action.key) : this.x11Key(action.key);
      case "hotkey":
        return this.isWayland ? this.waylandCombo(action.keys) : this.x11Combo(action.keys);
      case "select":
        return this.actSelect(action);
      case "toggle":
      case "invoke":
        return this.actInvoke(action.element, action.type);
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
        throw unsupported(`Action "${action.type}"`, "this is a mobile-only action on desktop platforms");
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

  /** click family: semantic AT-SPI doAction first, coordinate fallback. */
  private async actPointer(
    action: Extract<Action, { type: "click" | "double_click" | "right_click" | "long_press" }>,
  ): Promise<Omit<ActionResult, "durationMs">> {
    const el = action.element;
    const resolved = this.tryResolveElement(el);
    if (resolved && this.caps.accessibility) {
      const r = await this.atspiAct(resolved.path).catch(() => null);
      if (r?.ok) {
        return { ok: true, method: "semantic", element: el, detail: `atspi:${r.action ?? "action"}` };
      }
    }
    if (this.isWayland) {
      // Check the compositor restriction before demanding a coordinate —
      // "restricted" is the honest answer on Wayland, with or without bounds.
      this.requireWaylandPointer(action.type);
      const pt = this.requirePoint(action, el, resolved);
      const button = action.type === "right_click" ? "right" : "left";
      await this.exec("ydotool", wayland.buildYdotoolClick(pt.x, pt.y, button));
      return { ok: true, method: "coordinate", element: el, point: pt };
    }
    const pt = this.requirePoint(action, el, resolved);
    this.requireXdotool(action.type);
    if (action.type === "long_press") {
      await this.exec("xdotool", x11.buildMouseDown(pt.x, pt.y));
      await new Promise((r) => setTimeout(r, action.durationMs ?? 800));
      await this.exec("xdotool", x11.buildMouseUp(pt.x, pt.y));
    } else {
      await this.exec("xdotool", x11.buildClick(pt.x, pt.y, action.type === "right_click" ? "right" : "left", action.type === "double_click" ? 2 : 1));
    }
    return { ok: true, method: "coordinate", element: el, point: pt };
  }

  private async x11Move(point: PointInSpace): Promise<Omit<ActionResult, "durationMs">> {
    this.requireXdotool("move");
    const pt = this.pointFromAction(point);
    await this.exec("xdotool", x11.buildMouseMove(pt.x, pt.y));
    return { ok: true, method: "coordinate", point: pt };
  }

  private async waylandMove(point: PointInSpace): Promise<Omit<ActionResult, "durationMs">> {
    this.requireWaylandPointer("move");
    const pt = this.pointFromAction(point);
    await this.exec("ydotool", wayland.buildYdotoolMouseMove(pt.x, pt.y));
    return { ok: true, method: "coordinate", point: pt };
  }

  private async actType(action: Extract<Action, { type: "type" }>): Promise<Omit<ActionResult, "durationMs">> {
    const el = action.element;
    const resolved = this.tryResolveElement(el);
    if (resolved && this.caps.accessibility) {
      const r = await this.atspiSetText(resolved.path, action.text).catch(() => null);
      if (r?.ok) {
        if (action.submit) await this.pressEnter();
        return { ok: true, method: "semantic", element: el, detail: "atspi:setTextContents" };
      }
    }
    if (this.isWayland) {
      if (this.detection.tools.wtype) {
        await this.exec("wtype", wayland.buildWtypeText(action.text));
      } else if (this.detection.tools.ydotool && this.detection.tools.ydotoold) {
        await this.exec("ydotool", wayland.buildYdotoolType(action.text));
      } else {
        throw wayland.waylandKeyboardError("type");
      }
      if (action.submit) await this.pressEnter();
      return { ok: true, method: "coordinate", element: el };
    }
    this.requireXdotool("type");
    if (resolved?.bounds) {
      await this.exec("xdotool", x11.buildClick(resolved.bounds.x + resolved.bounds.width / 2, resolved.bounds.y + resolved.bounds.height / 2));
    }
    await this.exec("xdotool", x11.buildTypeText(action.text));
    if (action.submit) await this.exec("xdotool", x11.buildKey("Return"));
    return { ok: true, method: "coordinate", element: el };
  }

  private async actSetValue(el: ElementRef | undefined, value: string): Promise<Omit<ActionResult, "durationMs">> {
    if (!el) {
      // element-less clear: select-all + delete on the focused widget
      if (this.isWayland) throw wayland.waylandKeyboardError("clear (no element given)");
      this.requireXdotool("clear");
      await this.exec("xdotool", x11.buildCombo(["ctrl", "a"]));
      await this.exec("xdotool", x11.buildKey("Delete"));
      return { ok: true, method: "coordinate" };
    }
    const resolved = this.requireResolveElement(el);
    if (this.caps.accessibility) {
      const r = await this.atspiSetText(resolved.path, value).catch(() => null);
      if (r?.ok) return { ok: true, method: "semantic", element: el, detail: "atspi:setTextContents" };
    }
    if (this.isWayland) {
      // No xdotool coordinate fallback exists on Wayland — stay honest.
      throw wayland.waylandKeyboardError(`set_value on "${el.name ?? el.id}" (AT-SPI setTextContents failed)`);
    }
    this.requireXdotool("set_value");
    if (resolved.bounds) {
      await this.exec("xdotool", x11.buildClick(resolved.bounds.x + resolved.bounds.width / 2, resolved.bounds.y + resolved.bounds.height / 2));
    }
    await this.exec("xdotool", x11.buildCombo(["ctrl", "a"]));
    if (value) await this.exec("xdotool", x11.buildTypeText(value));
    else await this.exec("xdotool", x11.buildKey("Delete"));
    return { ok: true, method: "coordinate", element: el };
  }

  private async x11Key(key: string): Promise<Omit<ActionResult, "durationMs">> {
    this.requireXdotool("press");
    await this.exec("xdotool", x11.buildKey(key));
    return { ok: true, method: "coordinate" };
  }

  private async x11Combo(keys: string[]): Promise<Omit<ActionResult, "durationMs">> {
    this.requireXdotool("hotkey");
    await this.exec("xdotool", x11.buildCombo(keys));
    return { ok: true, method: "coordinate" };
  }

  private async pressEnter(): Promise<void> {
    if (this.isWayland) {
      await this.waylandKey("Return");
      return;
    }
    this.requireXdotool("press");
    await this.exec("xdotool", x11.buildKey("Return"));
  }

  private async waylandKey(key: string): Promise<Omit<ActionResult, "durationMs">> {
    if (this.detection.tools.wtype) {
      await this.exec("wtype", wayland.buildWtypeKey(key));
      return { ok: true, method: "coordinate" };
    }
    if (this.detection.tools.ydotool && this.detection.tools.ydotoold) {
      await this.exec("ydotool", wayland.buildYdotoolKey(key));
      return { ok: true, method: "coordinate" };
    }
    throw wayland.waylandKeyboardError(`press "${key}"`);
  }

  private async waylandCombo(keys: string[]): Promise<Omit<ActionResult, "durationMs">> {
    if (this.detection.tools.wtype) {
      await this.exec("wtype", wayland.buildWtypeCombo(keys));
      return { ok: true, method: "coordinate" };
    }
    if (this.detection.tools.ydotool && this.detection.tools.ydotoold) {
      await this.exec("ydotool", wayland.buildYdotoolCombo(keys));
      return { ok: true, method: "coordinate" };
    }
    throw wayland.waylandKeyboardError(`hotkey ${keys.join("+")}`);
  }

  private async actSelect(action: Extract<Action, { type: "select" }>): Promise<Omit<ActionResult, "durationMs">> {
    const resolved = this.requireResolveElement(action.element);
    if (action.value !== undefined) {
      return this.actSetValue(action.element, action.value);
    }
    return this.actInvoke(action.element, "select", resolved);
  }

  /** Semantic doAction (prefers press/click/toggle in the walker) + coordinate fallback on X11. */
  private async actInvoke(
    el: ElementRef | undefined,
    what: string,
    preResolved?: ResolvedAtspi,
  ): Promise<Omit<ActionResult, "durationMs">> {
    if (!el) throw new ComputerUseError("invalid_request", `${what} requires an element`);
    const resolved = preResolved ?? this.requireResolveElement(el);
    if (this.caps.accessibility) {
      const r = await this.atspiAct(resolved.path).catch(() => null);
      if (r?.ok) return { ok: true, method: "semantic", element: el, detail: `atspi:${r.action ?? "action"}` };
    }
    if (this.isWayland) {
      throw wayland.waylandPointerError(`${what} on "${el.name ?? el.id}" (AT-SPI doAction failed)`);
    }
    this.requireXdotool(what);
    const b = resolved.bounds ?? el.bounds;
    if (!b) throw new ComputerUseError("invalid_request", `no bounds for coordinate fallback of element ${el.id}`);
    const pt = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    await this.exec("xdotool", x11.buildClick(pt.x, pt.y));
    return { ok: true, method: "coordinate", element: el, point: pt };
  }

  // -------------------------------------------------------------------------
  // Apps & windows
  // -------------------------------------------------------------------------

  async listApps(): Promise<AppInfo[]> {
    if (this.isWayland) {
      if (!this.caps.accessibility) return [];
      const nodes = await this.ensureTree().catch(() => [] as atspi.AtspiNode[]);
      const seen = new Map<string, AppInfo>();
      for (const n of nodes) {
        if (n.depth === 0 && n.name && !seen.has(n.name)) seen.set(n.name, { name: n.name, frontmost: false });
      }
      return [...seen.values()];
    }
    if (!this.detection.tools.wmctrl) return [];
    const r = await this.exec("wmctrl", ["-l", "-x"], 10_000).catch(() => null);
    if (!r) return [];
    const entries = x11.parseWmctrlListX(r.stdout);
    const map = new Map<string, AppInfo>();
    for (const e of entries) {
      if (e.wmClass && !map.has(e.wmClass)) map.set(e.wmClass, { name: e.wmClass, identifier: e.wmClass });
    }
    const active = (await this.getActiveWindowId()) ?? this.activeWindowId;
    if (active) {
      const hex = x11.toWmctrlId(active).toLowerCase();
      const match = entries.find((e) => e.id.toLowerCase() === hex);
      if (match) {
        const app = map.get(match.wmClass);
        if (app) app.frontmost = true;
      }
    }
    return [...map.values()];
  }

  async listWindows(): Promise<WindowInfo[]> {
    if (this.isWayland) return []; // compositor-specific; honestly empty (see capabilities.notes)
    if (!this.detection.tools.wmctrl) return [];
    const r = await this.exec("wmctrl", ["-l", "-G"], 10_000).catch(() => null);
    if (!r) return [];
    const windows = x11.parseWmctrlListG(r.stdout);
    const active = (await this.getActiveWindowId()) ?? this.activeWindowId;
    if (!active) return windows;
    const hex = x11.toWmctrlId(active).toLowerCase();
    return windows.map((w) => (w.id.toLowerCase() === hex ? { ...w, focused: true } : w));
  }

  async launchApp(app: string, options: LaunchOptions = {}): Promise<void> {
    const args = options.args ?? [];
    if (this.detection.tools["gtk-launch"]) {
      const r = await this.exec("gtk-launch", [app, ...args], 15_000);
      if (r.code !== 0) {
        throw new ComputerUseError("element_not_found", `Cannot launch "${app}": ${(r.stderr || r.stdout).trim().slice(0, 200)}`, {
          hint: "Use the .desktop application id (e.g. firefox, org.gnome.Nautilus).",
        });
      }
      return;
    }
    if (this.detection.tools.gio) {
      const r = await this.exec("gio", ["launch", `${app}.desktop`], 15_000);
      if (r.code !== 0) {
        throw new ComputerUseError("element_not_found", `Cannot launch "${app}" via gio: ${(r.stderr || r.stdout).trim().slice(0, 200)}`, {
          hint: "gio launch needs a .desktop file path; prefer installing gtk-launch.",
        });
      }
      return;
    }
    throw restricted("launch_app", "no application launcher found (gtk-launch/gio)", INSTALL_HINTS.launcher);
  }

  async terminateApp(app: string): Promise<void> {
    if (!this.detection.tools.killall) {
      throw restricted("terminate_app", "killall not found", "install psmisc (provides killall)");
    }
    const r = await this.exec("killall", [app], 10_000);
    if (r.code !== 0) {
      throw new ComputerUseError("element_not_found", `No process named "${app}" (killall exit ${r.code})`, {
        hint: "Use the exact process name as shown by `ps -e`.",
      });
    }
  }

  async focusTarget(options: { app?: string; windowTitle?: string }): Promise<void> {
    if (this.isWayland) throw wayland.waylandWindowControlError("focus");
    if (!this.detection.tools.wmctrl) {
      throw restricted("focus", "wmctrl not found", INSTALL_HINTS.wmctrl);
    }
    if (!options.app && !options.windowTitle) {
      throw new ComputerUseError("invalid_request", "focus requires app or windowTitle");
    }
    const args = options.app ? ["-x", "-a", options.app] : ["-a", options.windowTitle!];
    const r = await this.exec("wmctrl", args, 10_000);
    if (r.code !== 0) {
      throw new ComputerUseError("element_not_found", `wmctrl could not focus "${options.app ?? options.windowTitle}": ${(r.stderr || r.stdout).trim().slice(0, 200)}`, {
        hint: "Use an exact window title (`wmctrl -l`) or WM_CLASS (`wmctrl -lx`).",
      });
    }
  }
}

/**
 * Cheap availability probe for the router (never throws, no session opened).
 * Only claims available when at least one automation capability is real.
 */
export async function linuxProbe(deps: LinuxAdapterDeps = {}): Promise<TargetProbe> {
  const hostPlatform = deps.hostPlatform ?? process.platform;
  if (hostPlatform !== "linux") {
    return { available: false, reason: `linux adapter requires a linux host (got ${hostPlatform})` };
  }
  try {
    const detection = await probeLinux(deps.exec ?? defaultExec, deps.env ?? process.env);
    const session = detection.session.session;
    const details: Record<string, unknown> = {
      session: detection.session,
      tools: detection.tools,
      pyatspi: detection.pyatspi,
    };
    if (session !== "x11" && session !== "wayland") {
      return { available: false, reason: "No graphical session detected (DISPLAY/WAYLAND_DISPLAY unset)", details };
    }
    const caps = buildCapabilities(detection);
    const usable = caps.screenshot || caps.accessibility || caps.globalInput || caps.windowControl || caps.appControl;
    return {
      available: usable,
      reason: usable
        ? undefined
        : "No usable automation tools found — install xdotool/wmctrl/scrot (X11) or grim/wtype (Wayland)",
      details: { ...details, capabilities: caps },
    };
  } catch (e) {
    return { available: false, reason: (e as Error).message };
  }
}
