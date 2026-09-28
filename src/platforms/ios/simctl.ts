/**
 * iOS Simulator control via `xcrun simctl` (spec §10 — target kind "simulator").
 *
 * simctl provides device discovery, screenshots and app management, but
 * NO accessibility tree and NO input injection. Tree/input come from WDA
 * (wda.ts) or idb (idb.ts); this module is the always-honest fallback
 * layer for simulators:
 *   - discovery:  `xcrun simctl list devices -j`
 *   - screenshot: `xcrun simctl io <udid> screenshot -`  (PNG on stdout;
 *                 older Xcode builds reject "-" → temp-file fallback)
 *   - app mgmt:   launch / terminate / install / openurl
 *
 * All process execution is injectable so unit tests run hermetically.
 * Text commands reuse the shared run() helper; the screenshot path needs
 * a binary-safe runner (PNG on stdout must not be decoded as UTF-8).
 */
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerUseError } from "../../core/errors.js";
import { run as defaultTextRun } from "../exec.js";

export type RunFn = (cmd: string, args: string[], timeoutMs?: number) => Promise<{
  code: number;
  stdout: string;
  stderr: string;
}>;

export type RunBinaryFn = (cmd: string, args: string[], timeoutMs?: number) => Promise<{
  code: number;
  stdout: Buffer;
  stderr: string;
}>;

export interface SimctlOptions {
  /** text commands (list/launch/terminate/install/openurl) — default shared run() */
  run?: RunFn;
  /** binary-safe commands (screenshot to stdout) — default execFile(encoding:buffer) */
  runBinary?: RunBinaryFn;
  readFile?: typeof readFile;
  rmFn?: typeof rm;
  /** xcrun binary; override for tests. Default "xcrun" (PATH lookup). */
  xcrunPath?: string;
  timeoutMs?: number;
}

export interface SimDevice {
  name: string;
  udid: string;
  /** "Booted" | "Shutdown" in practice; kept raw for honesty */
  state: string;
  deviceTypeIdentifier?: string;
  /** runtime key, e.g. "com.apple.CoreSimulator.SimRuntime.iOS-17-4" */
  runtime?: string;
  isAvailable?: boolean;
}

export function isBooted(d: SimDevice): boolean {
  return d.state === "Booted";
}

const XCRUN_TIMEOUT = 15_000;

function defaultRunBinary(cmd: string, args: string[], timeoutMs = 30_000): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const opts = { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, encoding: "buffer" } as const;
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      const e = err as (Error & { killed?: boolean; code?: number | string }) | null;
      if (e && e.killed) {
        resolve({ code: 124, stdout: Buffer.alloc(0), stderr: `${cmd} timed out after ${timeoutMs}ms` });
        return;
      }
      resolve({
        code: e ? (typeof e.code === "number" ? e.code : 1) : 0,
        stdout: Buffer.from(stdout as unknown as Uint8Array),
        stderr: typeof stderr === "string" ? stderr : String(stderr ?? ""),
      });
    });
  });
}

/** Parse `xcrun simctl list devices -j` output. Pure; unit-tested with fixtures. */
export function parseSimctlList(text: string): SimDevice[] {
  let parsed: { devices?: Record<string, Array<Record<string, unknown>>> };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch (e) {
    throw new ComputerUseError("provider_error", "simctl list -j returned invalid JSON", { cause: e });
  }
  const out: SimDevice[] = [];
  for (const [runtime, list] of Object.entries(parsed.devices ?? {})) {
    for (const d of list ?? []) {
      const udid = typeof d.udid === "string" ? d.udid : undefined;
      if (!udid) continue;
      out.push({
        name: typeof d.name === "string" ? d.name : "Unnamed",
        udid,
        state: typeof d.state === "string" ? d.state : "Unknown",
        deviceTypeIdentifier: typeof d.deviceTypeIdentifier === "string" ? d.deviceTypeIdentifier : undefined,
        runtime,
        isAvailable: d.isAvailable !== false,
      });
    }
  }
  return out;
}

/**
 * Cheap probe: `xcrun --find simctl`. Never throws.
 * On hosts without full Xcode (like this dev machine) it fails honestly.
 */
export async function probeSimctl(run: RunFn = defaultTextRun, xcrunPath = "xcrun"): Promise<{ ok: boolean; path?: string; error?: string }> {
  const r = await run(xcrunPath, ["--find", "simctl"], XCRUN_TIMEOUT).catch((e: Error) => ({
    code: -1,
    stdout: "",
    stderr: e.message,
  }));
  if (r.code === 0 && r.stdout.trim()) return { ok: true, path: r.stdout.trim() };
  return { ok: false, error: r.stderr.trim() || r.stdout.trim() || `xcrun --find simctl exited ${r.code}` };
}

export class Simctl {
  private readonly run: RunFn;
  private readonly runBinary: RunBinaryFn;
  private readonly readFileFn: typeof readFile;
  private readonly rmFn: typeof rm;
  private readonly xcrun: string;
  private readonly timeoutMs: number;

  constructor(opts: SimctlOptions = {}) {
    this.run = opts.run ?? defaultTextRun;
    this.runBinary = opts.runBinary ?? defaultRunBinary;
    this.readFileFn = opts.readFile ?? readFile;
    this.rmFn = opts.rmFn ?? rm;
    this.xcrun = opts.xcrunPath ?? "xcrun";
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private simctlArgs(args: string[]): string[] {
    return ["simctl", ...args];
  }

  async probe(): Promise<{ ok: boolean; path?: string; error?: string }> {
    return probeSimctl(this.run, this.xcrun);
  }

  /** List all simulators. Throws provider_error when simctl is unusable. */
  async listDevices(): Promise<SimDevice[]> {
    const r = await this.run(this.xcrun, this.simctlArgs(["list", "devices", "-j"]), this.timeoutMs);
    if (r.code !== 0) {
      throw new ComputerUseError("provider_error", `simctl list devices failed: ${r.stderr.trim() || `exit ${r.code}`}`, {
        hint: "simctl ships with Xcode. Install Xcode (or Command Line Tools with a full simulator runtime) — docs/install/ios.md",
      });
    }
    return parseSimctlList(r.stdout);
  }

  /**
   * Pick the target device: explicit UDID wins; otherwise the first
   * booted device, else the first device of any state (reported honestly).
   */
  pickDevice(devices: SimDevice[], udid?: string): SimDevice {
    if (udid) {
      const found = devices.find((d) => d.udid === udid);
      if (!found) {
        throw new ComputerUseError("device_not_found", `No simulator with UDID ${udid}`, {
          hint: "Run `xcrun simctl list devices` to list available UDIDs.",
        });
      }
      return found;
    }
    return devices.find(isBooted) ?? devices[0] ?? (() => {
      throw new ComputerUseError("device_not_found", "No iOS simulators exist on this host", {
        hint: "Create one in Xcode (Settings → Platforms) or `xcrun simctl create`.",
      });
    })();
  }

  /**
   * Screenshot a simulator as PNG.
   * Primary: `simctl io <udid> screenshot -` (PNG bytes on stdout).
   * Fallback: temp file (`screenshot <path>`) for older simctl builds that
   * reject "-", then read + delete the file.
   */
  async screenshot(udid: string): Promise<Buffer> {
    const primary = await this.runBinary(this.xcrun, this.simctlArgs(["io", udid, "screenshot", "-"]), this.timeoutMs);
    if (primary.code === 0 && isPng(primary.stdout)) return primary.stdout;

    const path = join(tmpdir(), `ui-venus-ios-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
    const r = await this.run(this.xcrun, this.simctlArgs(["io", udid, "screenshot", path]), this.timeoutMs);
    if (r.code !== 0) {
      const why = r.stderr.trim() || primary.stderr.trim() || `exit ${r.code}`;
      throw new ComputerUseError("device_offline", `simctl screenshot failed: ${why}`, {
        details: { udid },
        hint: "Is the simulator booted? `xcrun simctl boot <udid>` then retry.",
      });
    }
    try {
      const buf = await this.readFileFn(path);
      if (!isPng(Buffer.from(buf as unknown as Uint8Array))) {
        throw new ComputerUseError("provider_error", `simctl screenshot produced a non-PNG file at ${path}`);
      }
      return Buffer.from(buf as unknown as Uint8Array);
    } finally {
      await this.rmFn(path, { force: true }).catch(() => {});
    }
  }

  async launchApp(udid: string, bundleId: string, args: string[] = []): Promise<void> {
    const r = await this.run(this.xcrun, this.simctlArgs(["launch", udid, bundleId, ...args]), this.timeoutMs);
    if (r.code !== 0) {
      throw new ComputerUseError("element_not_found", `simctl launch ${bundleId} failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`, {
        details: { udid, bundleId },
        hint: "Use the app's bundle id (e.g. com.apple.Preferences). `xcrun simctl listapps <udid>` lists installed ids.",
      });
    }
  }

  async terminateApp(udid: string, bundleId: string): Promise<void> {
    const r = await this.run(this.xcrun, this.simctlArgs(["terminate", udid, bundleId]), this.timeoutMs);
    if (r.code !== 0) {
      throw new ComputerUseError("element_not_found", `simctl terminate ${bundleId} failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`, {
        details: { udid, bundleId },
      });
    }
  }

  async installApp(udid: string, appPath: string): Promise<void> {
    const r = await this.run(this.xcrun, this.simctlArgs(["install", udid, appPath]), this.timeoutMs);
    if (r.code !== 0) {
      throw new ComputerUseError("invalid_request", `simctl install failed: ${r.stderr.trim() || `exit ${r.code}`}`, {
        details: { udid, appPath },
      });
    }
  }

  async openUrl(udid: string, url: string): Promise<void> {
    const r = await this.run(this.xcrun, this.simctlArgs(["openurl", udid, url]), this.timeoutMs);
    if (r.code !== 0) {
      throw new ComputerUseError("invalid_request", `simctl openurl failed: ${r.stderr.trim() || `exit ${r.code}`}`, {
        details: { udid, url },
      });
    }
  }
}

/** Parse `xcrun simctl listapps <udid>` output. Handles BOTH encodings seen
 * in the wild: XML plists (newer Xcode) and OpenStep plists (older). */
export function parseListapps(text: string): Array<{ bundleId: string; name?: string }> {
  const out: Array<{ bundleId: string; name?: string }> = [];
  const seen = new Set<string>();

  if (text.includes("<plist") || text.includes("<dict>")) {
    const dictRe = /<dict>([\s\S]*?)<\/dict>/g;
    for (const block of text.matchAll(dictRe)) {
      const body = block[1] ?? "";
      const bundleId = xmlStringValue(body, "CFBundleIdentifier");
      if (!bundleId || seen.has(bundleId)) continue;
      seen.add(bundleId);
      out.push({ bundleId, name: xmlStringValue(body, "CFBundleDisplayName") ?? xmlStringValue(body, "CFBundleName") });
    }
  }

  if (out.length === 0) {
    // OpenStep style:  com.example.App = { CFBundleIdentifier = "com.example.App"; CFBundleName = App; ... };
    const entryRe = /([A-Za-z0-9.\-_]+)\s*=\s*\{([^{}]*)\}/g;
    for (const m of text.matchAll(entryRe)) {
      const body = m[2] ?? "";
      const bundleId = openStepStringValue(body, "CFBundleIdentifier") ?? (m[1]?.includes(".") ? m[1] : undefined);
      if (!bundleId || seen.has(bundleId)) continue;
      seen.add(bundleId);
      out.push({
        bundleId,
        name: openStepStringValue(body, "CFBundleDisplayName") ?? openStepStringValue(body, "CFBundleName"),
      });
    }
  }
  return out;
}

function xmlStringValue(block: string, key: string): string | undefined {
  const m = block.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
  const v = m?.[1]?.trim();
  return v || undefined;
}

function openStepStringValue(block: string, key: string): string | undefined {
  const m = block.match(new RegExp(`${key}\\s*=\\s*"?([^";]+)"?\\s*;`));
  const v = m?.[1]?.trim();
  return v || undefined;
}

export function isPng(buf: Buffer): boolean {
  return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50;
}
