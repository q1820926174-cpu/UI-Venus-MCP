/**
 * RemoteConnector — the transport seam for "奇葩环境" integration (spec §13).
 *
 * The MCP core never assumes it runs on the machine it controls. A
 * RemoteConnector is the pluggable link to a remote target: it carries
 * opaque command envelopes and binary payloads across whatever the
 * environment allows (SSH here; RDP/VNC/serial/cloud-desktop connectors
 * are future implementations of this same interface).
 *
 * The reference implementation, SshQueueConnector, targets hosts that are:
 *  - SSH-only (key auth), possibly intranet-isolated (no internet)
 *  - running Windows where SSH lands in session 0 (no desktop: capture
 *    and SendInput are denied) — solved by a file-queue agent running in
 *    the interactive session (see scripts/win-remote/queue-agent.ps1)
 *  - unable to run Node/the MCP themselves
 */

/** One op envelope travelling to the bridge. */
export interface BridgeCommand {
  id: string;
  op: string;
  mode?: string;
  args?: Record<string, unknown>;
  out?: string;
}

/** Result coming back. `json` is the bridge script's parsed stdout. */
export interface BridgeResult {
  id: string;
  ok: boolean;
  exit: number;
  json?: unknown;
  stdout: string;
  stderr: string;
  at: string;
}

export type ConnectorExec = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface RemoteConnector {
  readonly kind: string;
  /** Send one op and await its result. Throws ComputerUseError on transport/bridge failure. */
  command(op: string, extra?: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResult>;
  /** Fetch a binary produced on the remote side (e.g. a captured PNG). */
  fetchBinary(remotePath: string, localPath: string): Promise<void>;
  /** Cheap liveness probe. */
  ping(timeoutMs?: number): Promise<void>;
}
