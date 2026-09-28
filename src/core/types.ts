/**
 * Core shared types of the Cross-Platform Computer-Use MCP.
 *
 * Design rules (see docs/architecture.md):
 *  - Everything is expressed against a unified Target schema; nothing
 *    defaults implicitly to "local Windows".
 *  - Element references (ElementRef) carry semantic identity; raw pixel
 *    coordinates are a fallback, never the primary currency.
 *  - Observations are rich but every field is optional per platform.
 */

export type Platform = "windows" | "linux" | "macos" | "android" | "ios" | "browser";

export const ALL_PLATFORMS: readonly Platform[] = [
  "windows",
  "linux",
  "macos",
  "android",
  "ios",
  "browser",
] as const;

/** Unified device target schema (spec §14). */
export interface Target {
  /** local: this machine. device: physical device. simulator: emulator/simulator. browser: a browser session. remote/vm: reserved for future adapters. */
  type: "local" | "device" | "simulator" | "browser" | "remote" | "vm";
  /** "auto" only valid with type=local: pick this machine's own platform. */
  platform: Platform | "auto";
  /** adb serial, iOS simulator UDID, WDA device id... */
  deviceId?: string;
  /** browser: chromium | firefox | webkit (default chromium) */
  browser?: string;
  /** browser: URL to open (or current page for get_target). */
  url?: string;
  /** browser: connect to an existing Chrome via CDP instead of launching. */
  cdpEndpoint?: string;
  /** future: remote/vm endpoints */
  host?: string;
}

/** Resolved target — what the router actually opened. */
export interface TargetInfo {
  id: string;
  platform: Platform;
  name: string;
  type: Target["type"];
  deviceId?: string;
  details?: Record<string, unknown>;
}

export interface TargetSummary {
  id: string;
  platform: Platform;
  type: Target["type"];
  name: string;
  available: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface Point {
  x: number;
  y: number;
}

/** A point that knows which coordinate space it lives in (spec §29). */
export interface PointInSpace extends Point {
  /** normalized: [0,1000] vision output space. screenshot: pixels inside the latest screenshot. logical: platform logical (DIP) space. physical: device pixels. */
  space?: "normalized" | "screenshot" | "logical" | "physical";
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Orientation = "portrait" | "landscape";

export interface DisplayInfo {
  id: string;
  /** logical origin (can be negative in multi-monitor setups) */
  x: number;
  y: number;
  /** logical size */
  width: number;
  height: number;
  /** devicePixelRatio / DPI scale factor (1, 2, 1.5 ...) */
  scale: number;
  primary: boolean;
}

export interface ScreenInfo {
  displays: DisplayInfo[];
  orientation: Orientation;
  /** logical size of the primary/main surface */
  width: number;
  height: number;
}

/** Which structured/vision source produced an element or action. */
export type ElementSource =
  | "uia" // Windows UI Automation
  | "atspi" // Linux AT-SPI2
  | "ax" // macOS Accessibility (AXUIElement)
  | "uiautomator" // Android UIAutomator hierarchy
  | "xcuitest" // iOS XCUITest / WDA element tree
  | "dom" // Browser DOM / aria tree
  | "vision"; // vision model (UI-Venus) — no semantic handle, coordinates only

/**
 * Unified element reference (spec §18). Adapters convert their native
 * handles (UIA runtime id, AXUIElement token, DOM xpath, UiNode path…)
 * into this shape. `bounds` is expressed in **screenshot pixel space** of
 * the observation it came from, so structured elements and vision
 * coordinates can be fused.
 */
export interface ElementRef {
  id: string;
  source: ElementSource;
  role?: string;
  name?: string;
  value?: string;
  description?: string;
  bounds?: Rect;
  clickable?: boolean;
  editable?: boolean;
  enabled?: boolean;
  checked?: boolean;
  selected?: boolean;
  focused?: boolean;
  attributes?: Record<string, string | number | boolean | null>;
}

/** Generic UI tree node (normalized across UIA/AT-SPI/AX/UIAutomator/XCUITest/DOM). */
export interface UINode extends ElementRef {
  children?: UINode[];
}

export interface AppInfo {
  name: string;
  /** bundle id / package name / exe path — platform dependent */
  identifier?: string;
  pid?: number;
  /** android current activity, browser current URL... */
  context?: string;
  frontmost?: boolean;
}

export interface WindowInfo {
  id: string;
  title: string;
  app?: string;
  bounds?: Rect;
  minimized?: boolean;
  focused?: boolean;
}

/** Per-target capability probe result (spec §33). Honest by construction. */
export interface Capabilities {
  screenshot: boolean;
  accessibility: boolean;
  dom: boolean;
  globalInput: boolean;
  windowControl: boolean;
  appControl: boolean;
  clipboard: boolean;
  multiDisplay: boolean;
  /** Honest restriction notes, e.g. "Wayland: global input requires compositor/portal permission". */
  notes?: string[];
}

export const NO_CAPABILITIES: Capabilities = {
  screenshot: false,
  accessibility: false,
  dom: false,
  globalInput: false,
  windowControl: false,
  appControl: false,
  clipboard: false,
  multiDisplay: false,
};

/**
 * A screenshot plus the metadata required to map any pixel in it back to
 * platform coordinates (spec §29/§30). `origin` is the logical-coordinate
 * location of the image's top-left corner (non-zero for window/display
 * captures, ROI crops and multi-monitor).
 */
export interface Screenshot {
  format: "png" | "jpeg";
  dataBase64: string;
  /** pixel size of the image itself */
  width: number;
  height: number;
  /** image pixels per logical pixel (devicePixelRatio); 1 when unknown */
  scale: number;
  /** logical coordinates of the image's top-left corner */
  origin: Point;
  orientation: Orientation;
  /** perceptual hash for same-screen / stagnation detection */
  hash?: string;
  capturedAt: number;
  targetId: string;
}

/** Cross-platform observation (spec §20). All optional per platform. */
export interface Observation {
  target: TargetInfo;
  screen: ScreenInfo;
  screenshot?: Screenshot;
  activeApp?: AppInfo;
  uiTree?: UINode;
  /** browser: aria snapshot / DOM outline */
  dom?: unknown;
  windows?: WindowInfo[];
  capabilities: Capabilities;
  capturedAt: number;
}

export interface OsInfo {
  platform: NodeJS.Platform;
  release: string;
  arch: string;
}
