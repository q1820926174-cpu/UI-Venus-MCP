/**
 * PlatformRouter (spec §14/§15/§41).
 *
 * Resolves unified Targets into adapter sessions. Sessions are isolated
 * per target id: state, history and screenshots never cross devices.
 * Adapters register per platform; availability is probed honestly.
 */
import type { Platform, Target, TargetInfo, TargetSummary } from "../core/types.js";
import { ComputerUseError } from "../core/errors.js";
import { evaluateDevice } from "../orchestrator/security.js";
import type { SecurityConfig } from "../orchestrator/security.js";
import type { PlatformAdapter } from "./adapter.js";

export type AdapterFactory = () => Promise<PlatformAdapter>;

export interface AdapterRegistration {
  platform: Platform | "mock";
  /** Builds an adapter instance for a resolved target. May return null when the current host can't serve this platform. */
  factory: AdapterFactory;
  /** Cheap availability probe for list_targets (must not throw). */
  probe(): Promise<{ available: boolean; reason?: string; details?: Record<string, unknown> }>;
}

export interface Session {
  target: Target;
  info: TargetInfo;
  adapter: PlatformAdapter;
  createdAt: number;
  /** per-session scratch (history, recording state) keyed by owner */
  data: Map<string, unknown>;
}

export class PlatformRouter {
  private registrations = new Map<string, AdapterRegistration>();
  private sessions = new Map<string, Session>();

  register(reg: AdapterRegistration): void {
    this.registrations.set(reg.platform, reg);
  }

  listRegistrations(): string[] {
    return [...this.registrations.keys()];
  }

  /** Enumerate targets the current host can serve (spec §15). */
  async listTargets(): Promise<TargetSummary[]> {
    const out: TargetSummary[] = [];
    for (const [platform, reg] of this.registrations) {
      try {
        const probe = await reg.probe();
        out.push({
          id: platform === "mock" ? "mock" : `${platform}:local`,
          platform: platform as Platform,
          type: "local",
          name: `${platform} target`,
          available: probe.available,
          reason: probe.reason,
          details: probe.details,
        });
      } catch (e) {
        out.push({
          id: `${platform}:local`,
          platform: platform as Platform,
          type: "local",
          name: `${platform} target`,
          available: false,
          reason: (e as Error).message,
        });
      }
    }
    return out;
  }

  async getTargetSummary(target: Target): Promise<TargetSummary> {
    const resolved = this.resolvePlatform(target);
    const reg = this.registrations.get(resolved);
    if (!reg) {
      return { id: `${resolved}:local`, platform: resolved as Platform, type: target.type, name: `${resolved} target`, available: false, reason: `No adapter registered for platform "${resolved}"` };
    }
    const probe = await reg.probe().catch((e: Error) => ({ available: false as const, reason: e.message, details: undefined }));
    return {
      id: `${resolved}:${target.deviceId ?? "local"}`,
      platform: resolved as Platform,
      type: target.type,
      name: `${resolved}${target.deviceId ? `:${target.deviceId}` : ""} target`,
      available: probe.available,
      reason: probe.reason,
      details: probe.details,
    };
  }

  /** Open (or reuse) the isolated session for a target. */
  async getSession(target: Target, security?: SecurityConfig): Promise<Session> {
    const resolved = this.resolvePlatform(target);
    const reg = this.registrations.get(resolved);
    if (!reg) {
      throw new ComputerUseError("unsupported", `No adapter registered for platform "${resolved}"`, {
        hint: `Registered platforms: ${[...this.registrations.keys()].join(", ")}`,
      });
    }
    const deviceId = target.deviceId ?? "local";
    const sessionId = `${resolved}:${deviceId}`;

    const deviceCheck = evaluateDevice(target.deviceId, security);
    if (deviceCheck.verdict === "deny") {
      throw new ComputerUseError("security_blocked", deviceCheck.reason);
    }

    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const adapter = await reg.factory();
    // The router assigns the canonical session id so identical adapters
    // serving different deviceIds remain distinguishable (spec §41).
    const info = { ...(await adapter.open()), id: sessionId };
    const session: Session = { target, info, adapter, createdAt: Date.now(), data: new Map() };
    this.sessions.set(sessionId, session);
    return session;
  }

  getSessionById(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): Session[] {
    return [...this.sessions.values()];
  }

  async closeSession(sessionId: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    await s.adapter.close().catch(() => {});
    this.sessions.delete(sessionId);
    return true;
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.closeSession(id);
  }

  /** Map a Target to a registered platform key. */
  private resolvePlatform(target: Target): string {
    if (target.type === "local" && (target.platform === "auto" || !target.platform)) {
      switch (process.platform) {
        case "darwin":
          return "macos";
        case "win32":
          return "windows";
        case "linux":
          return "linux";
        default:
          throw new ComputerUseError("unsupported", `Unsupported host platform ${process.platform}`);
      }
    }
    return target.platform;
  }
}
