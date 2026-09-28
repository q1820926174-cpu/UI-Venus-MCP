/**
 * PowerShell runner for the Windows adapter.
 *
 * Native bridges live as .ps1 files under `src/platforms/windows/scripts/`
 * and are executed with `powershell.exe -NoProfile -NonInteractive
 * -ExecutionPolicy Bypass -File`. Structured arguments are passed as
 * base64(UTF-8 JSON) to avoid every quoting/injection pitfall of the
 * Win32 command line; simple scalars go as named parameters.
 *
 * Scripts print machine-readable JSON on stdout and use distinct exit
 * codes + prefixed stderr markers (see each script header):
 *   PROCESS_NOT_FOUND / ELEMENT_NOT_FOUND -> element_not_found
 *   PATTERN_NOT_SUPPORTED                 -> unsupported
 *   INPUT_FAILED / ACTION_FAILED          -> restricted / stalled
 *   UNKNOWN_KEY / BAD_REGION              -> invalid_request
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ComputerUseError } from "../../core/errors.js";
import { run, type RunResult } from "../exec.js";

let cachedDir: string | null = null;

/** Locate the scripts directory (works from src, dist and repo root). */
export function scriptsDir(): string {
  if (cachedDir) return cachedDir;
  const override = process.env.UIVENUS_WINDOWS_SCRIPTS;
  if (override) {
    cachedDir = override;
    return cachedDir;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "scripts"),
    join(here, "..", "..", "..", "src", "platforms", "windows", "scripts"),
    join(process.cwd(), "src", "platforms", "windows", "scripts"),
  ];
  for (const dir of candidates) {
    try {
      readFileSync(join(dir, "uia-tree.ps1"), "utf8");
      cachedDir = dir;
      return dir;
    } catch {
      /* try next */
    }
  }
  throw new ComputerUseError("internal_error", `Windows PowerShell scripts not found (tried ${candidates.join(", ")})`);
}

/** Base64(UTF-8 JSON) payload — the only safe way to pass rich data into PS. */
export function encodeArgs(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj ?? {}), "utf8").toString("base64");
}

export async function runPowerShell(
  scriptName: string,
  args: string[],
  timeoutMs = 20_000,
): Promise<RunResult> {
  const exe = process.env.UIVENUS_POWERSHELL ?? "powershell.exe";
  const script = join(scriptsDir(), scriptName);
  return run(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args], timeoutMs);
}

/** Throw an honest ComputerUseError for a failed PS script, by stderr marker. */
export function failFromPs(scriptName: string, r: RunResult): ComputerUseError {
  const err = r.stderr.trim().split(/\r?\n/).filter(Boolean).pop() ?? r.stdout.trim();
  const details = { script: scriptName, exitCode: r.code, stderr: r.stderr.slice(0, 500) };
  if (/PROCESS_NOT_FOUND|ELEMENT_NOT_FOUND/.test(err)) {
    return new ComputerUseError("element_not_found", err, { details, hint: "Re-observe (the UI may have changed) or pick another target." });
  }
  if (/PATTERN_NOT_SUPPORTED/.test(err)) {
    return new ComputerUseError("unsupported", err, { details, hint: "Element lacks the required UIA pattern; coordinate fallback may apply." });
  }
  if (/INPUT_FAILED/.test(err)) {
    return new ComputerUseError("restricted", err, {
      details,
      hint: "SendInput was blocked (no interactive desktop in this session, or UIPI blocked it). Run inside the interactive console session; elevated windows need an elevated process.",
    });
  }
  if (/UNKNOWN_KEY|BAD_REGION/.test(err)) {
    return new ComputerUseError("invalid_request", err, { details });
  }
  if (/VERIFY_FAILED/.test(err)) {
    return new ComputerUseError("stalled", err, { details, hint: "The action ran but verification read back a different state; retry or use a different method." });
  }
  return new ComputerUseError("internal_error", `${scriptName} failed: ${err || `exit ${r.code}`}`, { details });
}

/** Parse a script's stdout JSON, throwing honest errors on failure. */
export function parsePsJson<T>(scriptName: string, r: RunResult): T {
  if (r.code !== 0) throw failFromPs(scriptName, r);
  const text = r.stdout.trim();
  if (!text) throw failFromPs(scriptName, { ...r, code: r.code || 1, stderr: r.stderr || "empty stdout" });
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new ComputerUseError("internal_error", `${scriptName}: stdout is not valid JSON`, {
      details: { excerpt: text.slice(0, 400) },
      cause: e,
    });
  }
}
