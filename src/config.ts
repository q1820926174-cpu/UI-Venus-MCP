/**
 * Configuration. Environment-first with sensible defaults so the server
 * runs out of the box:
 *   VENUS_BASE_URL / VENUS_API_KEY / VENUS_MODEL  — vision provider
 *   CUMCP_*                                       — server behavior
 *
 * API keys are read from the environment (or a git-ignored .env file);
 * they are never hard-coded or committed.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SecurityConfig } from "./orchestrator/security.js";

function loadDotEnv(): void {
  const candidates = [process.env.CUMCP_ENV_FILE, join(process.cwd(), ".env")];
  for (const p of candidates) {
    if (!p || !existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1] as string;
      let value = m[2] as string;
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}

loadDotEnv();

export interface VenusProviderConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
  temperature: number;
  enableThinking: boolean;
  minPixels: number;
  maxPixels: number;
  /** refuse plain-HTTP endpoints except private ranges / explicitly allowed */
  allowInsecureHttp: boolean;
}

export interface OrchestratorConfig {
  maxSteps: number;
  stepTimeoutMs: number;
  taskTimeoutMs: number;
  maxRecoveries: number;
  /** consecutive no-progress detections before giving up */
  maxStagnation: number;
}

export interface ScreenshotConfig {
  format: "png" | "jpeg";
  jpegQuality: number;
  /** downscale images whose larger side exceeds this before sending to vision */
  maxDimension: number;
}

export interface ServerConfig {
  defaultProvider: string;
  orchestrator: OrchestratorConfig;
  screenshot: ScreenshotConfig;
  security: SecurityConfig;
  venus: VenusProviderConfig;
}

function intEnv(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function boolEnv(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function isPrivateHttpHost(url: URL): boolean {
  const h = url.hostname;
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h.endsWith(".local") ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

export function loadConfig(overrides?: Partial<ServerConfig>): ServerConfig {
  const baseUrl = process.env.VENUS_BASE_URL ?? "http://36.138.102.62:8300/v1";
  const url = new URL(baseUrl);
  // Default true: self-hosted GPU boxes commonly serve plain HTTP. When
  // set to false, only https or private-range http endpoints are allowed.
  const allowInsecure = boolEnv("VENUS_ALLOW_INSECURE_HTTP", true);

  const cfg: ServerConfig = {
    defaultProvider: process.env.CUMCP_PROVIDER ?? "ui-venus",
    orchestrator: {
      maxSteps: intEnv("CUMCP_MAX_STEPS", 30),
      stepTimeoutMs: intEnv("CUMCP_STEP_TIMEOUT_MS", 120_000),
      taskTimeoutMs: intEnv("CUMCP_TASK_TIMEOUT_MS", 600_000),
      maxRecoveries: intEnv("CUMCP_MAX_RECOVERIES", 5),
      maxStagnation: intEnv("CUMCP_MAX_STAGNATION", 3),
    },
    screenshot: {
      format: (process.env.CUMCP_SCREENSHOT_FORMAT as "png" | "jpeg") ?? "png",
      jpegQuality: intEnv("CUMCP_JPEG_QUALITY", 80),
      maxDimension: intEnv("CUMCP_MAX_DIMENSION", 2560),
    },
    security: {
      confirmSensitiveActions: boolEnv("CUMCP_CONFIRM_SENSITIVE", true),
      sensitiveKeywords: (process.env.CUMCP_SENSITIVE_KEYWORDS?.split(",") ?? [
        "delete", "删除", "uninstall", "卸载", "pay", "支付", "付款", "transfer", "转账",
        "purchase", "下单", "buy", "format", "格式化", "send email", "发邮件", "send message", "发消息",
        "permission", "授权", "root", "factory reset",
      ]).map((s) => s.trim().toLowerCase()).filter(Boolean),
      allowedActions: process.env.CUMCP_ALLOWED_ACTIONS?.split(",").map((s) => s.trim()).filter(Boolean),
      blockedApps: process.env.CUMCP_BLOCKED_APPS?.split(",").map((s) => s.trim()).filter(Boolean),
      allowedApps: process.env.CUMCP_ALLOWED_APPS?.split(",").map((s) => s.trim()).filter(Boolean),
      allowedDomains: process.env.CUMCP_ALLOWED_DOMAINS?.split(",").map((s) => s.trim()).filter(Boolean),
      allowedDevices: process.env.CUMCP_ALLOWED_DEVICES?.split(",").map((s) => s.trim()).filter(Boolean),
      confirmationTimeoutMs: intEnv("CUMCP_CONFIRMATION_TIMEOUT_MS", 300_000),
    },
    venus: {
      baseUrl,
      apiKey: process.env.VENUS_API_KEY,
      model: process.env.VENUS_MODEL ?? "UI-Venus-2-9B-W8A8",
      timeoutMs: intEnv("VENUS_TIMEOUT_MS", 120_000),
      temperature: Number(process.env.VENUS_TEMPERATURE ?? "0"),
      enableThinking: boolEnv("VENUS_ENABLE_THINKING", false),
      minPixels: intEnv("VENUS_MIN_PIXELS", 3136),
      maxPixels: intEnv("VENUS_MAX_PIXELS", 12_845_056),
      allowInsecureHttp: allowInsecure,
    },
  };

  return { ...cfg, ...overrides };
}
