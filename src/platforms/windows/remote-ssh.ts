/**
 * RemoteWindowsAdapter — drive a remote Windows host over SSH (spec §13
 * remote-desktop architecture): the MCP stack (orchestrator + vision
 * provider) runs locally; the target only runs the inbox PowerShell
 * bridges via a session-1 file-queue agent (scripts/win-remote/queue-agent.ps1),
 * because SSH-spawned processes land in session 0 where capture/SendInput
 * are blocked.
 *
 * Wire protocol per command:
 *   enqueue  queue/<id>.cmd.json   {id, op, ...}      (via powershell -EncodedCommand)
 *   await    results/<id>.json     {id, ok, exit, stdout, ...}
 *   capture  additionally fetches results/<id>.png via scp
 *
 * Coordinates: screenshot pixel space == physical pixels (scale 1);
 * the remote capture is the coordinate authority.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PlatformAdapter, ObserveOptions, ScreenshotOptions, LaunchOptions } from "../adapter.js";
import type {
  Action,
  ActionResult,
} from "../../core/types-action.js";
import type {
  AppInfo,
  Capabilities,
  ElementRef,
  Observation,
  Screenshot,
  ScreenInfo,
  TargetInfo,
  UINode,
  WindowInfo,
} from "../../core/types.js";
import { ComputerUseError } from "../../core/errors.js";
import { processScreenshot } from "../../screenshot/pipeline.js";
import { parseUiTreeJson, buildUiTree, locateInElements, elementToRef } from "./ui-tree.js";

const exec = promisify(execFile);

export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface RemoteWindowsOptions {
  /** ssh alias or user@host (key auth required) */
  sshHost: string;
  /** directory on the host holding queue-agent.ps1 + scripts/ (windows paths) */
  remoteRoot: string;
  /** extra ssh args */
  sshArgs?: string[];
  screenshot?: { maxDimension?: number; format?: "png" | "jpeg" };
  exec?: ExecFn;
}

interface BridgeResult {
  id: string;
  ok: boolean;
  exit: number;
  json?: unknown;
  stdout: string;
  stderr: string;
  at: string;
}

function toWinPath(root: string, rel: string): string {
  return `${root}\\${rel.replace(/\//g, "\\")}`;
}

export class RemoteWindowsAdapter implements PlatformAdapter {
  readonly platform = "windows";
  private info!: TargetInfo;
  private caps!: Capabilities;
  private seq = 0;
  private screen?: { width: number; height: number };
  private readonly execFn: ExecFn;
  private readonly sshBase: string[];

  constructor(private readonly opts: RemoteWindowsOptions) {
    this.execFn = opts.exec ?? ((cmd, args) => exec(cmd, args, { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }));
    this.sshBase = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", ...(opts.sshArgs ?? [])];
  }

  private async ssh(command: string): Promise<string> {
    const { stdout } = await this.execFn("ssh", [...this.sshBase, this.opts.sshHost, command]);
    return stdout;
  }

  /** Escape hatch for driver scripts: run any bridge op directly. */
  async bridgeCommand(op: string, extra: Record<string, unknown> = {}, timeoutMs = 45_000): Promise<BridgeResult> {
    return this.command(op, extra, timeoutMs);
  }

  private async scpFrom(remotePath: string, localPath: string): Promise<void> {
    await this.execFn("scp", [...this.sshBase, `${this.opts.sshHost}:${remotePath.replace(/\\/g, "/")}`, localPath]);
  }

  /** Encode a PowerShell snippet as -EncodedCommand (UTF-16LE base64). */
  private static encoded(ps: string): string {
    return Buffer.from(ps, "utf16le").toString("base64");
  }

  /** Enqueue one op and await its result JSON. */
  private async command(op: string, extra: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<BridgeResult> {
    const id = `r${Date.now().toString(36)}${(this.seq++).toString(36)}`;
    const cmdFile = toWinPath(this.opts.remoteRoot, `queue\\${id}.cmd.json`);
    const resFile = toWinPath(this.opts.remoteRoot, `results\\${id}.json`);
    const payload = JSON.stringify({ id, op, ...extra });
    const b64 = Buffer.from(payload, "utf8").toString("base64");
    const ps = `Set-Content -Path '${cmdFile}' -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))) -Encoding UTF8`;
    await this.ssh(`powershell -NoProfile -EncodedCommand ${RemoteWindowsAdapter.encoded(ps)}`);

    const deadline = Date.now() + timeoutMs;
    let raw = "";
    while (Date.now() < deadline) {
      raw = await this.ssh(`powershell -NoProfile -Command "if (Test-Path '${resFile}') { Get-Content -Raw -Encoding UTF8 '${resFile}' } else { 'PENDING' }"`)
        .then((s) => s.trim())
        .catch(() => "PENDING");
      if (raw !== "PENDING" && raw !== "") break;
      await new Promise((r) => setTimeout(r, 150));
    }
    if (raw === "PENDING" || raw === "") {
      throw new ComputerUseError("timeout", `bridge command ${op} timed out after ${timeoutMs}ms`, {
        hint: "Is the session-1 queue agent running? (schtasks /run /tn uivenus-bridge)",
      });
    }
    // strip BOM; PS 5.1 ConvertTo-Json emits valid (spacious) JSON
    const cleaned = raw.replace(/^\uFEFF/, "");
    let parsed: BridgeResult;
    try {
      parsed = JSON.parse(cleaned) as BridgeResult;
    } catch {
      throw new ComputerUseError("provider_error", `bridge result unparseable for ${op}: ${cleaned.slice(0, 160)}`);
    }
    if (!parsed.ok && parsed.exit !== 0) {
      const msg = (parsed.stderr || parsed.stdout || `exit ${parsed.exit}`).slice(0, 200);
      const code = /CAPTURE_FAILED/.test(msg)
        ? "restricted"
        : /INPUT_FAILED/.test(msg)
          ? "restricted"
          : /PROCESS_NOT_FOUND|ELEMENT_NOT_FOUND/.test(msg)
            ? "element_not_found"
            : "internal_error";
      throw new ComputerUseError(code, `remote ${op} failed: ${msg}`);
    }
    return parsed;
  }

  async open(): Promise<TargetInfo> {
    // liveness + session reality
    const ping = await this.command("ping", {}, 15_000).catch((e: Error) => {
      throw new ComputerUseError("device_offline", `Windows bridge unreachable: ${e.message}`, {
        hint: "Start it in the interactive session: schtasks /run /tn uivenus-bridge (see scripts/win-remote/README.md)",
      });
    });
    void ping;
    let info: { virtualScreen?: { width?: number; height?: number } } = {};
    try {
      const sys = await this.command("sysinfo");
      info = JSON.parse(sys.stdout) as typeof info;
      this.screen = { width: info.virtualScreen?.width ?? 0, height: info.virtualScreen?.height ?? 0 };
    } catch {
      /* info optional */
    }
    // capability probe: one real capture
    let captureOk = false;
    try {
      const shot = await this.screenshot();
      captureOk = shot.dataBase64.length > 1000;
    } catch {
      captureOk = false;
    }
    this.caps = {
      screenshot: captureOk,
      accessibility: true, // uia via bridge
      dom: false,
      globalInput: captureOk, // same session gate as capture; verified by first input
      windowControl: true,
      appControl: true,
      clipboard: false,
      multiDisplay: false,
      notes: [
        "remote-ssh executor: capture/input run in the interactive session via the queue bridge",
        "UAC-elevated windows are not automatable (same integrity rule as local)",
      ],
    };
    this.info = {
      id: `remote-windows:${this.opts.sshHost}`,
      platform: "windows",
      type: "remote",
      name: `Remote Windows (${this.opts.sshHost})`,
      details: { bridge: "session-1 queue agent", screen: this.screen },
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

  async screenshot(options: ScreenshotOptions = {}): Promise<Screenshot> {
    const id = `s${Date.now().toString(36)}${(this.seq++).toString(36)}`;
    const rel = `results\\${id}.png`;
    const extra: Record<string, unknown> = { out: toWinPath(this.opts.remoteRoot, rel) };
    if (options.region) extra.args = { region: options.region };
    await this.command("capture", extra, 45_000);
    const dir = await mkdtemp(join(tmpdir(), "cumcp-rw-"));
    const local = join(dir, "shot.png");
    try {
      await this.scpFrom(toWinPath(this.opts.remoteRoot, rel), local);
      const raw = await readFile(local);
      const shot = processScreenshot(raw, {
        targetId: this.info?.id ?? "remote-windows",
        scale: 1,
        origin: options.region ? { x: options.region.x, y: options.region.y } : { x: 0, y: 0 },
        orientation: "landscape",
      }, this.opts.screenshot);
      this.lastShot = shot;
      return shot;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private lastShot?: Screenshot;
  private lastForegroundPid?: number;

  /** Foreground window bounds (physical px) via sysinfo→uia-tree, or null. */
  private async foregroundWindowBounds(): Promise<{ x: number; y: number; width: number; height: number } | null> {
    try {
      const sys = await this.command("sysinfo");
      const fg = (JSON.parse(sys.stdout) as { foreground?: { pid?: number; title?: string } }).foreground;
      if (!fg?.pid) return null;
      this.lastForegroundPid = fg.pid;
      const res = await this.command("uia-tree", { args: { pid: fg.pid, maxDepth: 1 } }, 30_000);
      const elements = JSON.parse(res.stdout) as { role: string; bounds?: { x: number; y: number; width: number; height: number } }[];
      const win = (Array.isArray(elements) ? elements : []).find(
        (e) => e.role === "ControlType.Window" && e.bounds && e.bounds.width > 100 && e.bounds.height > 80,
      );
      return win?.bounds ?? null;
    } catch {
      return null;
    }
  }

  async observe(options: ObserveOptions = {}): Promise<Observation> {
    let region: { x: number; y: number; width: number; height: number } | undefined;
    if (options.scope === "window") {
      region = (await this.foregroundWindowBounds()) ?? undefined;
    }
    const shot = options.includeScreenshot === false ? undefined : await this.screenshot(region ? { region } : {});
    let uiTree: UINode | undefined;
    if (options.includeUITree !== false) {
      try {
        // window scope: only the foreground window's subtree — keeps fusion
        // snapping precise and the payload small
        const args: Record<string, unknown> = region ? { pid: this.lastForegroundPid, maxDepth: 14 } : { desktopRoot: true };
        const res = await this.command("uia-tree", { args }, 45_000);
        const elements = parseUiTreeJson(res.stdout);
        uiTree = buildUiTree(elements) ?? undefined;
      } catch {
        uiTree = undefined;
      }
    }
    return {
      target: this.info,
      screen: {
        displays: this.screen ? [{ id: "0", x: 0, y: 0, width: this.screen.width, height: this.screen.height, scale: 1, primary: true }] : [],
        orientation: "landscape",
        width: this.screen?.width ?? shot?.width ?? 0,
        height: this.screen?.height ?? shot?.height ?? 0,
      },
      screenshot: shot,
      uiTree,
      capabilities: this.caps,
      capturedAt: Date.now(),
    };
  }

  async locate(descriptor: Parameters<PlatformAdapter["locate"]>[0]): Promise<{ element: ElementRef } | null> {
    const args: Record<string, unknown> = { desktopRoot: true };
    if (descriptor.role) args.role = descriptor.role;
    if (descriptor.name) args.name = descriptor.name;
    if (descriptor.text) args.text = descriptor.text;
    const res = await this.command("uia-tree", { args });
    const elements = parseUiTreeJson(res.stdout);
    const hit = locateInElements(elements, { role: descriptor.role, name: descriptor.name, text: descriptor.text, resourceId: descriptor.resourceId, index: descriptor.index });
    if (!hit) return null;
    return { element: elementToRef(hit) };
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

  private pointArgs(action: { point?: { x: number; y: number; space?: string } }): { x: number; y: number } | null {
    if (!action.point) return null;
    const space = action.point.space ?? "screenshot";
    if (space !== "screenshot" && space !== "physical") {
      throw new ComputerUseError("invalid_request", `remote adapter accepts screenshot/physical coordinates only (got ${space})`);
    }
    // screenshot pixels → physical: region captures offset by their origin (scale 1)
    const origin = space === "screenshot" ? (this.lastShot?.origin ?? { x: 0, y: 0 }) : { x: 0, y: 0 };
    return { x: Math.round(origin.x + action.point.x), y: Math.round(origin.y + action.point.y) };
  }

  private async executeInner(action: Action): Promise<Omit<ActionResult, "durationMs">> {
    switch (action.type) {
      case "click":
      case "double_click":
      case "right_click":
      case "long_press": {
        // fused elements carry UIA bounds (physical px) — their center is
        // the precise target; fall back to the model's point otherwise
        const el = "element" in action ? action.element : undefined;
        let p: { x: number; y: number } | null = null;
        let method: "semantic" | "coordinate" = "coordinate";
        if (el?.bounds && el.bounds.width > 0) {
          p = { x: Math.round(el.bounds.x + el.bounds.width / 2), y: Math.round(el.bounds.y + el.bounds.height / 2) };
          method = "semantic";
        } else {
          p = this.pointArgs(action as { point?: { x: number; y: number; space?: string } });
        }
        if (!p) throw new ComputerUseError("invalid_request", `${action.type} requires a point or element bounds (remote executor is coordinate-driven; use computer_locate first)`);
        await this.command("input", {
          mode: "click",
          args: { x: p.x, y: p.y, button: action.type === "right_click" ? "right" : "left", clicks: action.type === "double_click" ? 2 : 1 },
        });
        return { ok: true, method, point: p, element: el };
      }
      case "move": {
        const p = this.pointArgs(action);
        if (!p) throw new ComputerUseError("invalid_request", "move requires a point");
        await this.command("input", { mode: "move", args: p });
        return { ok: true, method: "coordinate", point: p };
      }
      case "drag": {
        if (!action.from?.point || !action.to?.point) throw new ComputerUseError("invalid_request", "drag requires from.point/to.point");
        const from = this.pointArgs({ point: action.from.point })!;
        const to = this.pointArgs({ point: action.to.point })!;
        await this.command("input", { mode: "drag", args: { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, durationMs: action.durationMs ?? 400 } });
        return { ok: true, method: "coordinate", point: to };
      }
      case "scroll": {
        const anchor = action.point ? this.pointArgs(action as { point?: { x: number; y: number; space?: string } }) : { x: 960, y: 540 };
        await this.command("input", { mode: "scroll", args: { x: anchor!.x, y: anchor!.y, direction: action.direction, amount: action.amount ?? 3 } });
        return { ok: true, method: "coordinate" };
      }
      case "type": {
        await this.command("input", { mode: "type", args: { text: action.text } });
        if (action.submit) await this.command("input", { mode: "key", args: { key: "enter" } });
        return { ok: true, method: "coordinate" };
      }
      case "press":
        await this.command("input", { mode: "key", args: { key: action.key } });
        return { ok: true, method: "coordinate" };
      case "hotkey": {
        const mods = action.keys.slice(0, -1);
        const key = action.keys[action.keys.length - 1]!;
        await this.command("input", { mode: "key", args: { key, modifiers: mods } });
        return { ok: true, method: "coordinate" };
      }
      case "launch_app":
        await this.command("apps", { mode: "launch", args: { app: action.app } });
        return { ok: true, method: "system" };
      case "terminate_app":
        await this.command("apps", { mode: "kill", args: { app: action.app } });
        return { ok: true, method: "system" };
      case "focus": {
        if (action.app) await this.command("apps", { mode: "launch", args: { app: action.app } });
        return { ok: true, method: "system" };
      }
      case "wait":
        await new Promise((r) => setTimeout(r, action.durationMs));
        return { ok: true, method: "system" };
      case "finish":
      case "fail":
        return { ok: true, method: "system" };
      default:
        throw new ComputerUseError("unsupported", `remote executor does not support "${action.type}" (semantic element actions need local UIA; use coordinate flow)`);
    }
  }

  async listApps(): Promise<AppInfo[]> {
    return [];
  }

  async listWindows(): Promise<WindowInfo[]> {
    try {
      const res = await this.command("uia-tree", { args: { desktopRoot: true, maxDepth: 1 } });
      const elements = parseUiTreeJson(res.stdout);
      return elements
        .filter((e) => e.role === "ControlType.Window")
        .map((e, i) => ({
          id: `rwin:${i}`,
          title: e.name ?? "",
          app: e.pid ? `pid:${e.pid}` : undefined,
          bounds: e.bounds ?? undefined,
          focused: false,
        }));
    } catch {
      return [];
    }
  }

  async launchApp(app: string, _options?: LaunchOptions): Promise<void> {
    await this.command("apps", { mode: "launch", args: { app } });
  }

  async terminateApp(app: string): Promise<void> {
    await this.command("apps", { mode: "kill", args: { app } });
  }

  async focusTarget(options: { app?: string; windowTitle?: string }): Promise<void> {
    if (options.app) await this.launchApp(options.app);
  }
}
