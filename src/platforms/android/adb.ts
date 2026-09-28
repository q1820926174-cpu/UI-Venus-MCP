/**
 * adb bridge — binary discovery, device listing and exec wrappers.
 *
 * Everything here is injectable so unit tests run hermetically on hosts
 * WITHOUT adb installed: pass `exec` (and optionally `adbPath`/`discover`)
 * to AdbClient/AndroidAdapter. The default exec shells out to the real
 * binary and maps adb's stderr into the shared error taxonomy:
 *   device not found → device_not_found · offline → device_offline ·
 *   unauthorized → permission_required (RSA dialog hint).
 */
import { execFile, type ExecFileOptionsWithBufferEncoding } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ComputerUseError } from "../../core/errors.js";

export interface AdbResult {
  code: number;
  stdout: string;
  /** raw bytes — required for `exec-out screencap -p` (binary PNG) */
  stdoutBuffer: Buffer;
  stderr: string;
}

export interface AdbExecOptions {
  timeoutMs?: number;
  /** caller expects binary output; exec must not corrupt stdout */
  binary?: boolean;
}

/** Injectable process runner — same shape as the default implementation. */
export type AdbExecFn = (file: string, args: string[], opts?: AdbExecOptions) => Promise<AdbResult>;

/** Default exec: execFile with a hard timeout and buffer capture. */
export function defaultAdbExec(file: string, args: string[], opts: AdbExecOptions = {}): Promise<AdbResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const options: ExecFileOptionsWithBufferEncoding = {
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    encoding: "buffer",
  };
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      const e = err as (Error & { killed?: boolean; code?: number | string }) | null;
      if (e && e.killed) {
        reject(new ComputerUseError("timeout", `adb ${args[0] ?? ""} timed out after ${timeoutMs}ms`));
        return;
      }
      const outBuf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout), "utf8");
      const errBuf = Buffer.isBuffer(stderr) ? stderr : Buffer.from(String(stderr), "utf8");
      resolve({
        code: e ? (typeof e.code === "number" ? e.code : 1) : 0,
        stdout: outBuf.toString("utf8"),
        stdoutBuffer: outBuf,
        stderr: errBuf.toString("utf8"),
      });
    });
  });
}

export interface AdbDevice {
  serial: string;
  state: "device" | "offline" | "unauthorized" | (string & {});
  model?: string;
  product?: string;
}

export interface AdbDiscoveryDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
}

/** Candidate adb locations, in probe order (ANDROID_HOME → platform default → PATH). */
export function adbCandidates(deps: AdbDiscoveryDeps = {}): string[] {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const binary = platform === "win32" ? "adb.exe" : "adb";
  const out: string[] = [];
  const push = (p?: string | null): void => {
    if (p) out.push(p);
  };
  if (env.ANDROID_HOME) push(join(env.ANDROID_HOME, "platform-tools", binary));
  if (env.ANDROID_SDK_ROOT) push(join(env.ANDROID_SDK_ROOT, "platform-tools", binary));
  if (platform === "darwin" && env.HOME) {
    push(join(env.HOME, "Library", "Android", "sdk", "platform-tools", binary));
  }
  if (platform === "linux") push(`/usr/lib/android-sdk/platform-tools/${binary}`);
  const sep = platform === "win32" ? ";" : ":";
  for (const dir of (env.PATH ?? "").split(sep)) {
    if (dir.trim()) push(join(dir, binary));
  }
  return out;
}

/** First candidate that exists on disk, or null. Pure — deps injectable for tests. */
export function discoverAdbPath(deps: AdbDiscoveryDeps = {}): string | null {
  const exists = deps.exists ?? ((p: string) => existsSync(p));
  for (const p of adbCandidates(deps)) {
    if (exists(p)) return p;
  }
  return null;
}

/** Parse `adb devices -l` (also tolerates plain `adb devices`). */
export function parseDevices(raw: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("List of devices attached") || trimmed.startsWith("*")) continue;
    const cols = trimmed.split(/\s+/);
    const serial = cols[0];
    const state = cols[1];
    if (!serial || !state) continue;
    const model = cols.find((c) => c.startsWith("model:"))?.slice(6);
    const product = cols.find((c) => c.startsWith("product:"))?.slice(8);
    devices.push({ serial, state: state as AdbDevice["state"], model, product });
  }
  return devices;
}

/**
 * Map a failed adb invocation to the shared error taxonomy. Never fakes
 * success: unauthorized devices are a PERMISSION gap (the RSA dialog must
 * be accepted by a human on the device), not a hard failure of adb.
 */
export function adbError(context: string, res: AdbResult): ComputerUseError {
  const text = `${res.stderr}\n${res.stdout}`;
  const lower = text.toLowerCase();
  if (lower.includes("unauthorized")) {
    return new ComputerUseError("permission_required", `${context}: device is unauthorized for adb debugging`, {
      hint: "Accept the 'Allow USB debugging' RSA dialog on the device screen (re-plug the cable to re-trigger it, or run `adb kill-server && adb devices`).",
      details: { stderr: text.slice(0, 500) },
    });
  }
  if (lower.includes("offline")) {
    return new ComputerUseError("device_offline", `${context}: device is offline`, {
      hint: "Wake/re-plug the device; check `adb devices` state becomes 'device'.",
      details: { stderr: text.slice(0, 500) },
    });
  }
  if (lower.includes("not found") || lower.includes("no devices") || lower.includes("doesn't match")) {
    return new ComputerUseError("device_not_found", `${context}: device not found`, {
      hint: "Enable USB debugging and connect the device, or pass the exact serial from `adb devices -l`.",
      details: { stderr: text.slice(0, 500) },
    });
  }
  if (lower.includes("more than one device")) {
    return new ComputerUseError("invalid_request", `${context}: more than one device attached`, {
      hint: "Disambiguate with a deviceId (serial).",
    });
  }
  return new ComputerUseError("internal_error", `${context} failed: ${(res.stderr || res.stdout).trim().slice(0, 300)}`);
}

/**
 * Quote a value destined for the ON-DEVICE shell. adb concatenates argv and
 * runs it through the device's sh, so spaces and metacharacters must be
 * wrapped/escaped here (host-side execFile already avoids host-shell issues).
 */
export function quoteDeviceArg(s: string): string {
  return `"${s.replace(/[\\$"`]/g, (c) => `\\${c}`)}"`;
}

export interface AdbClientOptions {
  /** Explicit binary path (tests). */
  adbPath?: string;
  /** Injectable exec (tests). Defaults to defaultAdbExec. */
  exec?: AdbExecFn;
  /** Injectable discovery (tests). Defaults to discoverAdbPath(). */
  discover?: () => string | null;
}

export class AdbClient {
  /** Set once the binary is resolved; null until then. */
  resolvedPath: string | null = null;
  private exec: AdbExecFn;
  private discover: () => string | null;

  constructor(private opts: AdbClientOptions = {}) {
    this.exec = opts.exec ?? defaultAdbExec;
    this.discover = opts.discover ?? ((): string | null => discoverAdbPath());
  }

  /** Resolve (and cache) the adb binary. Throws unsupported when absent. */
  async path(): Promise<string> {
    if (this.resolvedPath) return this.resolvedPath;
    if (this.opts.adbPath) {
      this.resolvedPath = this.opts.adbPath;
      return this.resolvedPath;
    }
    // Injected exec ⇒ hermetic: the test double owns execution, so skip
    // host discovery entirely and use a sentinel binary name.
    if (this.opts.exec) {
      this.resolvedPath = "adb";
      return this.resolvedPath;
    }
    const p = this.discover();
    if (!p) {
      throw new ComputerUseError("unsupported", "adb executable not found — cannot drive Android devices from this host", {
        hint: "Install Android platform-tools (e.g. `brew install --cask android-platform-tools`), set ANDROID_HOME, or put adb on PATH.",
      });
    }
    this.resolvedPath = p;
    return p;
  }

  /** `adb devices -l` — parse into AdbDevice[]. */
  async devices(): Promise<AdbDevice[]> {
    const p = await this.path();
    const res = await this.exec(p, ["devices", "-l"], { timeoutMs: 10_000 });
    if (res.code !== 0 && !res.stdout.trim()) throw adbError("adb devices", res);
    return parseDevices(res.stdout);
  }

  /** `adb -s <serial> …` with honest error mapping on non-zero exit. */
  async device(serial: string, args: string[], opts: AdbExecOptions = {}): Promise<AdbResult> {
    const p = await this.path();
    const res = await this.exec(p, ["-s", serial, ...args], { timeoutMs: 20_000, ...opts });
    if (res.code !== 0) throw adbError(`adb -s ${serial} ${args[0] ?? ""}`, res);
    return res;
  }

  /** `adb -s <serial> shell …` returning trimmed stdout. */
  async shell(serial: string, args: string[], opts: AdbExecOptions = {}): Promise<string> {
    const res = await this.device(serial, ["shell", ...args], opts);
    return res.stdout.trim();
  }
}
