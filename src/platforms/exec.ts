/**
 * Process-execution helpers for native bridges (osascript / jxa / CLI tools).
 */
import { execFile } from "node:child_process";
import { ComputerUseError } from "../core/errors.js";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(cmd: string, args: string[], timeoutMs = 20_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      const e = err as (Error & { killed?: boolean; code?: number | string }) | null;
      if (e && e.killed) {
        reject(new ComputerUseError("timeout", `${cmd} timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr });
    });
  });
}

/** AppleScript (-e). Throws ComputerUseError with honest codes on failure. */
export async function osascript(script: string, timeoutMs = 20_000): Promise<string> {
  const r = await run("/usr/bin/osascript", ["-e", script], timeoutMs);
  if (r.code !== 0) {
    const msg = r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`;
    throw new ComputerUseError("internal_error", `osascript failed: ${msg}`, {
      details: { stderr: r.stderr.slice(0, 500) },
    });
  }
  return r.stdout;
}

/** JavaScript for Automation (-l JavaScript -e). */
export async function jxa(script: string, timeoutMs = 20_000): Promise<string> {
  const r = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], timeoutMs);
  if (r.code !== 0) {
    const msg = r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`;
    throw new ComputerUseError("internal_error", `jxa failed: ${msg}`, {
      details: { stderr: r.stderr.slice(0, 500) },
    });
  }
  return r.stdout;
}

export function unsupportedOnThisPlatform(expected: string): ComputerUseError {
  return new ComputerUseError("unsupported", `This adapter requires ${expected}`, {
    hint: "Run the MCP on the matching platform or target a device that provides it.",
  });
}
