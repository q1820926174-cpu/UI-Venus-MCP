/**
 * Named remote-target registry.
 *
 * The 151-style integration is the NORM for this MCP: most targets are
 * remote boxes with odd access constraints. Operators describe them in ONE
 * place and every layer (router, list_targets, delegate loop) addresses
 * them by name:
 *
 *   CUMCP_REMOTES='[
 *     { "name": "win-151",  "platform": "windows", "kind": "ssh-queue",
 *       "sshHost": "goldagent-151", "root": "C:\\Users\\gold\\win-remote" },
 *     { "name": "win-lab2", "platform": "windows", "kind": "ssh-queue",
 *       "sshHost": "lab2", "root": "C:\\Users\\lab\\win-remote" }
 *   ]'
 *
 * or the single-target shorthand (kept for backwards compatibility):
 *   CUMCP_REMOTE_WINDOWS_SSH + CUMCP_REMOTE_WINDOWS_ROOT
 */
import { ComputerUseError } from "../core/errors.js";
import type { Platform } from "../core/types.js";

export type ConnectorKind = "ssh-queue";

export interface RemoteTargetConfig {
  name: string;
  platform: Platform;
  kind: ConnectorKind;
  /** ssh alias or user@host (key auth) */
  sshHost: string;
  /** windows path holding queue-agent.ps1 + scripts/ */
  root: string;
  /** optional extra ssh args */
  sshArgs?: string[];
}

export function parseRemotes(env: NodeJS.ProcessEnv = process.env): RemoteTargetConfig[] {
  const out: RemoteTargetConfig[] = [];

  const json = env.CUMCP_REMOTES;
  if (json) {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch (e) {
      throw new ComputerUseError("invalid_request", `CUMCP_REMOTES is not valid JSON: ${(e as Error).message}`);
    }
    const list = Array.isArray(raw) ? raw : [raw];
    for (const [i, item] of list.entries()) {
      const o = item as Record<string, unknown>;
      const name = typeof o.name === "string" ? o.name : `remote-${i}`;
      const platform = o.platform;
      const kind = (o.kind ?? "ssh-queue") as ConnectorKind;
      const sshHost = o.sshHost ?? o.host;
      const root = o.root ?? o.remoteRoot;
      if (typeof platform !== "string" || !["windows", "linux", "macos"].includes(platform)) {
        throw new ComputerUseError("invalid_request", `CUMCP_REMOTES[${i}]: platform must be windows|linux|macos`);
      }
      if (kind !== "ssh-queue") {
        throw new ComputerUseError("unsupported", `CUMCP_REMOTES[${i}]: unknown connector kind "${kind}"`);
      }
      if (typeof sshHost !== "string" || !sshHost) {
        throw new ComputerUseError("invalid_request", `CUMCP_REMOTES[${i}].sshHost is required`);
      }
      if (typeof root !== "string" || !root) {
        throw new ComputerUseError("invalid_request", `CUMCP_REMOTES[${i}].root is required`);
      }
      out.push({
        name,
        platform: platform as Platform,
        kind,
        sshHost,
        root,
        sshArgs: Array.isArray(o.sshArgs) ? (o.sshArgs as string[]) : undefined,
      });
    }
  }

  // shorthand: the original single-remote env pair
  const single = env.CUMCP_REMOTE_WINDOWS_SSH;
  if (single && !out.some((r) => r.sshHost === single)) {
    out.push({
      name: "windows-remote",
      platform: "windows",
      kind: "ssh-queue",
      sshHost: single,
      root: env.CUMCP_REMOTE_WINDOWS_ROOT ?? "C:\\Users\\gold\\win-remote",
    });
  }

  return out;
}
