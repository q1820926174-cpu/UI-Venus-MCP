/**
 * Security layer (spec §35).
 *
 * - App/device/action/domain allow & deny lists.
 * - Sensitive-action detection → WAITING_CONFIRMATION instead of silent
 *   execution. Never blocks the calling agent from deciding: the tool
 *   returns a confirmation token, execution resumes after confirm.
 */
import type { Action } from "../core/types-action.js";
import { ComputerUseError } from "../core/errors.js";

export interface SecurityConfig {
  /** when true (default), sensitive actions require confirmation */
  confirmSensitiveActions: boolean;
  /** lowercase keywords that mark an action/text as sensitive */
  sensitiveKeywords: string[];
  allowedActions?: string[];
  allowedApps?: string[];
  blockedApps?: string[];
  allowedDomains?: string[];
  allowedDevices?: string[];
  confirmationTimeoutMs: number;
}

export type Decision =
  | { verdict: "allow" }
  | { verdict: "deny"; reason: string }
  | { verdict: "confirm"; reason: string };

const APP_BEARING_ACTIONS = new Set(["launch_app", "terminate_app", "focus"]);
const TEXT_BEARING_ACTIONS = new Set(["type", "set_value"]);
const ALWAYS_STRUCTURAL = new Set(["wait", "finish", "fail", "home", "back", "screenshot"]);

/** Evaluate an action against the security policy. */
export function evaluateAction(action: Action, cfg: SecurityConfig): Decision {
  if (cfg.allowedActions && cfg.allowedActions.length > 0 && !ALWAYS_STRUCTURAL.has(action.type)) {
    if (!cfg.allowedActions.includes(action.type)) {
      return { verdict: "deny", reason: `action "${action.type}" not in allowedActions` };
    }
  }

  if (APP_BEARING_ACTIONS.has(action.type)) {
    const app = (action as { app?: string }).app ?? "";
    const appVerdict = evaluateAppName(app, cfg);
    if (appVerdict.verdict !== "allow") return appVerdict;
  }

  if (TEXT_BEARING_ACTIONS.has(action.type)) {
    const text = (action as { text?: string; value?: string }).text ??
      (action as { value?: string }).value ?? "";
    if (matchesSensitive(text, cfg)) {
      return { verdict: "confirm", reason: `typed text matches sensitive keywords` };
    }
    const domainVerdict = evaluateTypedUrl(text, cfg);
    if (domainVerdict.verdict !== "allow") return domainVerdict;
  }

  if (action.type === "click" || action.type === "invoke" || action.type === "toggle") {
    const el = (action as { element?: { name?: string } }).element;
    if (el?.name && matchesSensitive(el.name, cfg)) {
      return { verdict: "confirm", reason: `element "${el.name}" matches sensitive keywords` };
    }
  }

  if (action.type === "launch_app" || action.type === "terminate_app" || action.type === "type") {
    const probe = `${(action as { app?: string }).app ?? ""} ${(action as { text?: string }).text ?? ""}`;
    if (matchesSensitive(probe, cfg)) {
      return { verdict: "confirm", reason: "action matches sensitive keywords" };
    }
  }

  return { verdict: "allow" };
}

export function evaluateAppName(app: string, cfg: SecurityConfig): Decision {
  const lower = app.toLowerCase();
  if (cfg.blockedApps?.some((b) => lower.includes(b.toLowerCase()))) {
    return { verdict: "deny", reason: `app "${app}" is blocked by policy` };
  }
  if (cfg.allowedApps && cfg.allowedApps.length > 0) {
    if (!cfg.allowedApps.some((a) => lower.includes(a.toLowerCase()))) {
      return { verdict: "deny", reason: `app "${app}" not in allowedApps` };
    }
  }
  return { verdict: "allow" };
}

/** Domain allowlist applies to URLs being typed. */
export function evaluateTypedUrl(text: string, cfg: SecurityConfig): Decision {
  const urlMatch = text.match(/https?:\/\/[^\s]+/i);
  if (!urlMatch || !cfg.allowedDomains || cfg.allowedDomains.length === 0) return { verdict: "allow" };
  try {
    const host = new URL(urlMatch[0]).hostname;
    const ok = cfg.allowedDomains.some((d) => host === d || host.endsWith(`.${d}`));
    return ok
      ? { verdict: "allow" }
      : { verdict: "deny", reason: `domain "${host}" not in allowedDomains` };
  } catch {
    return { verdict: "allow" };
  }
}

export function matchesSensitive(text: string, cfg: SecurityConfig): boolean {
  const lower = text.toLowerCase();
  return cfg.sensitiveKeywords.some((k) => lower.includes(k));
}

/** Device-id gate for multi-device setups. */
export function evaluateDevice(deviceId: string | undefined, cfg?: SecurityConfig): Decision {
  if (!cfg?.allowedDevices || cfg.allowedDevices.length === 0 || !deviceId) return { verdict: "allow" };
  return cfg.allowedDevices.includes(deviceId)
    ? { verdict: "allow" }
    : { verdict: "deny", reason: `device "${deviceId}" not in allowedDevices` };
}

/**
 * Confirmation tokens: pending sensitive actions park here until the
 * caller confirms with computer_execute_task/computer_action
 * { confirmToken }. Expired tokens are rejected.
 */
export class ConfirmationRegistry {
  private pending = new Map<
    string,
    { action: Action; reason: string; expiresAt: number; resolve?: () => void; reject?: (e: Error) => void }
  >();
  private seq = 0;

  park(action: Action, reason: string, timeoutMs: number): string {
    const token = `confirm-${Date.now().toString(36)}-${(this.seq++).toString(36)}`;
    this.pending.set(token, { action, reason, expiresAt: Date.now() + timeoutMs });
    return token;
  }

  /** Await human/agent confirmation; resolves when confirm() is called. */
  waitFor(token: string, timeoutMs: number): Promise<void> {
    const entry = this.pending.get(token);
    if (!entry) {
      return Promise.reject(
        new ComputerUseError("invalid_request", `Unknown confirmation token: ${token}`),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(token);
        reject(new ComputerUseError("timeout", "Confirmation timed out; action not executed"));
      }, Math.min(timeoutMs, entry.expiresAt - Date.now()));
      entry.resolve = () => {
        clearTimeout(timer);
        this.pending.delete(token);
        resolve();
      };
      entry.reject = (e) => {
        clearTimeout(timer);
        this.pending.delete(token);
        reject(e);
      };
    });
  }

  confirm(token: string): boolean {
    const entry = this.pending.get(token);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.pending.delete(token);
      return false;
    }
    entry.resolve?.();
    return true;
  }

  cancel(token: string): boolean {
    const entry = this.pending.get(token);
    if (!entry) return false;
    entry.reject?.(new ComputerUseError("cancelled", "Confirmation rejected by caller"));
    return true;
  }

  /** Inspect without consuming (for computer_get_task). */
  peek(token: string): { reason: string; expiresAt: number } | undefined {
    const e = this.pending.get(token);
    return e ? { reason: e.reason, expiresAt: e.expiresAt } : undefined;
  }
}
