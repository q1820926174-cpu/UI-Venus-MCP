/**
 * PlatformAdapter — the platform abstraction layer (spec §5, §48).
 *
 * Every platform (windows/linux/macos/android/ios/browser, and future
 * remote/vm) implements this interface. The orchestrator never branches
 * on platform; differences live inside adapters, including:
 *  - translating unified Actions into native semantics,
 *  - mapping native element handles into ElementRef/UINode,
 *  - reporting honest Capabilities (spec §33) and permission gaps (§34).
 */
import type { ActionResult, Action } from "../core/types-action.js";
import type {
  Capabilities,
  Observation,
  Screenshot,
  Target,
  TargetInfo,
  WindowInfo,
  AppInfo,
} from "../core/types.js";

export interface ObserveOptions {
  includeScreenshot?: boolean;
  includeUITree?: boolean;
  includeDom?: boolean;
  maxTreeDepth?: number;
  /** "window": capture the frontmost app's window region (better vision legibility for small windows); default "screen" */
  scope?: "window" | "screen";
}

export interface ScreenshotOptions {
  /** logical-region capture (desktop) or window id capture */
  windowId?: string;
  displayId?: string;
  region?: { x: number; y: number; width: number; height: number };
}

export interface LaunchOptions {
  args?: string[];
}

export interface AdapterContext {
  target: Target;
  /** resolved target info, filled by the adapter during open() */
  info?: TargetInfo;
}

export interface PlatformAdapter {
  readonly platform: string;

  /** Probe environment and open a session against the target. Must not assume anything exists. */
  open(): Promise<TargetInfo>;
  close(): Promise<void>;

  getTargetInfo(): TargetInfo;
  getCapabilities(): Capabilities;

  observe(options?: ObserveOptions): Promise<Observation>;
  screenshot(options?: ScreenshotOptions): Promise<Screenshot>;

  /** Find an element by semantic descriptor; structured sources first. */
  locate(descriptor: {
    role?: string;
    name?: string;
    text?: string;
    resourceId?: string;
    css?: string;
    xpath?: string;
    testId?: string;
    index?: number;
  }): Promise<{ element: import("../core/types.js").ElementRef } | null>;

  /** Execute a unified action. Must translate to native semantics when available. */
  executeAction(action: Action): Promise<ActionResult>;

  listApps(): Promise<AppInfo[]>;
  listWindows(): Promise<WindowInfo[]>;
  launchApp(app: string, options?: LaunchOptions): Promise<void>;
  terminateApp(app: string): Promise<void>;
  focusTarget(options: { app?: string; windowTitle?: string }): Promise<void>;
}
