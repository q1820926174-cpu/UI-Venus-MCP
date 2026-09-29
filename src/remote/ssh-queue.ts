/**
 * SshQueueConnector — file-queue transport over SSH (the "151 pattern").
 *
 * Wire protocol (per command):
 *   enqueue  <root>/queue/<id>.cmd.json   via `powershell -EncodedCommand`
 *   await    <root>/results/<id>.json     polled via `Get-Content -Raw -Encoding UTF8`
 *   binary   additionally fetched via scp
 *
 * Payloads are base64 in both directions, so CJK content survives any
 * console codepage. The remote side is scripts/win-remote/queue-agent.ps1
 * running in the target's INTERACTIVE session (started once via
 * schtasks /IT with the wscript hidden launcher — see
 * scripts/win-remote/bootstrap-remote.mjs).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ComputerUseError } from "../core/errors.js";
import type { BridgeCommand, BridgeResult, ConnectorExec, RemoteConnector } from "./types.js";

export type { BridgeResult } from "./types.js";

const exec = promisify(execFile);

export interface SshQueueOptions {
  sshHost: string;
  /** windows-path root holding queue-agent.ps1 + scripts/ + queue/ + results/ */
  remoteRoot: string;
  sshArgs?: string[];
  pollIntervalMs?: number;
  exec?: ConnectorExec;
}

export class SshQueueConnector implements RemoteConnector {
  readonly kind = "ssh-queue";
  private readonly execFn: ConnectorExec;
  private readonly sshBase: string[];
  private seq = 0;

  constructor(private readonly opts: SshQueueOptions) {
    this.execFn = opts.exec ?? ((cmd, args) => exec(cmd, args, { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }));
    this.sshBase = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", ...(opts.sshArgs ?? [])];
  }

  private toWin(rel: string): string {
    return `${this.opts.remoteRoot}\\${rel.replace(/\//g, "\\")}`;
  }

  async ssh(command: string): Promise<string> {
    const { stdout } = await this.execFn("ssh", [...this.sshBase, this.opts.sshHost, command]);
    return stdout;
  }

  /** Encode a PowerShell snippet as -EncodedCommand (UTF-16LE base64). */
  private static encoded(ps: string): string {
    return Buffer.from(ps, "utf16le").toString("base64");
  }

  async command(op: string, extra: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<BridgeResult> {
    const id = `r${Date.now().toString(36)}${(this.seq++).toString(36)}`;
    const cmdFile = this.toWin(`queue\\${id}.cmd.json`);
    const resFile = this.toWin(`results\\${id}.json`);
    const payload = JSON.stringify({ id, op, ...extra } satisfies BridgeCommand);
    const b64 = Buffer.from(payload, "utf8").toString("base64");
    const ps = `Set-Content -Path '${cmdFile}' -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))) -Encoding UTF8`;
    await this.ssh(`powershell -NoProfile -EncodedCommand ${SshQueueConnector.encoded(ps)}`);

    const interval = this.opts.pollIntervalMs ?? 150;
    const deadline = Date.now() + timeoutMs;
    let raw = "";
    while (Date.now() < deadline) {
      // base64 round-trip: printing UTF-8 through the PS console (cp936)
      // mangles CJK — encode the file bytes and decode locally instead
      raw = await this.ssh(
        `powershell -NoProfile -Command "if (Test-Path '${resFile}') { [Convert]::ToBase64String([IO.File]::ReadAllBytes('${resFile}')) } else { 'PENDING' }"`,
      )
        .then((s) => s.trim())
        .catch(() => "PENDING");
      if (raw !== "PENDING" && raw !== "" && /^[A-Za-z0-9+/=\s]+$/.test(raw)) {
        raw = Buffer.from(raw, "base64").toString("utf8");
      }
      if (raw !== "PENDING" && raw !== "") break;
      await new Promise((r) => setTimeout(r, interval));
    }
    if (raw === "PENDING" || raw === "") {
      throw new ComputerUseError("timeout", `bridge command ${op} timed out after ${timeoutMs}ms`, {
        hint: "Is the session-1 queue agent running? (scripts/win-remote/bootstrap-remote.mjs brings it up)",
      });
    }
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

  async fetchBinary(remotePath: string, localPath: string): Promise<void> {
    await this.execFn("scp", [...this.sshBase, `${this.opts.sshHost}:${remotePath.replace(/\\/g, "/")}`, localPath]);
  }

  async ping(timeoutMs = 15_000): Promise<void> {
    try {
      await this.command("ping", {}, timeoutMs);
    } catch (e) {
      throw new ComputerUseError("device_offline", `remote bridge unreachable: ${(e as Error).message}`, {
        hint: "Run scripts/win-remote/bootstrap-remote.mjs <ssh-alias> to (re)install the session-1 bridge.",
      });
    }
  }
}
