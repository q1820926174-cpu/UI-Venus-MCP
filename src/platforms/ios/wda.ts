/**
 * WebDriverAgent (WDA) REST client — Appium-compatible subset.
 *
 * This is the ONLY automation channel for REAL iOS devices (spec §10,
 * target kind "device"), and the preferred tree/input channel for
 * simulators when it is reachable. Implemented endpoints:
 *
 *   GET    /status                              probe / readiness
 *   POST   /session                             create session (W3C body)
 *   DELETE /session/:sid                        cleanup
 *   GET    /session/:sid/window/size            logical screen size (points)
 *   GET    /session/:sid/source?format=json     accessible element tree
 *   POST   /session/:sid/elements               find by strategy+value
 *   POST   /session/:sid/element/:eid/click     semantic tap
 *   POST   /session/:sid/element/:id/value      type into element
 *   POST   /session/:sid/element/:id/clear      clear element
 *   POST   /session/:sid/wda/tap/0              coordinate tap
 *   POST   /session/:sid/wda/doubleTap          coordinate double tap
 *   POST   /session/:sid/wda/touchAndHold       long press
 *   POST   /session/:sid/wda/dragfromtoforduration  swipe / drag
 *   POST   /session/:sid/wda/pressHome          home button
 *   POST   /session/:sid/wda/type               type into focused element
 *   POST   /session/:sid/wda/keys               keyboard chars
 *   GET    /session/:sid/wda/activeAppInfo      frontmost app
 *   POST   /session/:sid/wda/apps/launch        launch by bundle id
 *   POST   /session/:sid/wda/apps/terminate     terminate by bundle id
 *   POST   /session/:sid/wda/apps/activate      activate by bundle id
 *   POST   /session/:sid/url                    open URL (Safari/deeplink)
 *   GET    /screenshot                          PNG (base64, device pixels)
 *
 * Honesty rules (spec §34):
 *  - unreachable WDA ⇒ permission_required with setup hints (Developer
 *    Mode, signing/provisioning, "Trust this computer", iproxy) — never
 *    a silent failure and never faked success.
 *  - every request has a timeout (AbortController); fetch is injectable
 *    so unit tests run hermetically against JSON fixtures.
 */
import { ComputerUseError, permissionRequired } from "../../core/errors.js";
import type { Rect } from "../../core/types.js";
import { coerceFrame, normalizeIosRole } from "./idb.js";

export interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchFn = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<FetchResponse>;

function defaultFetch(url: string, init?: Parameters<FetchFn>[1]): Promise<FetchResponse> {
  return fetch(url, init as RequestInit | undefined) as unknown as Promise<FetchResponse>;
}

export interface WdaClientOptions {
  /** Default: env IOS_WDA_URL, else WDA_URL, else http://localhost:8100 */
  baseUrl?: string;
  fetchFn?: FetchFn;
  timeoutMs?: number;
}

export interface WdaStatus {
  ready: boolean;
  state: string;
  osName?: string;
  osVersion?: string;
  raw: Record<string, unknown>;
}

export interface WdaSourceNode {
  role: string;
  label?: string;
  name?: string;
  value?: string;
  identifier?: string;
  frame?: Rect;
  enabled: boolean;
  children: WdaSourceNode[];
  raw: Record<string, unknown>;
}

export const WDA_SETUP_HINT =
  "Build & run WebDriverAgent against the device: (1) enable Developer Mode on the device " +
  "(Settings → Privacy & Security → Developer Mode); (2) build WDA in Xcode with a signing " +
  "certificate + provisioning profile for this device; (3) unlock the device and accept " +
  "\"Trust This Computer\"; (4) expose the port: `iproxy 8100 8100 <udid>` (libimobiledevice). " +
  "Details: docs/install/ios.md";

/** Honest failure for an unreachable / not-ready WDA backend. */
export function wdaUnavailableError(baseUrl: string, cause?: string): ComputerUseError {
  return permissionRequired(`WebDriverAgent at ${baseUrl}`, WDA_SETUP_HINT, {
    details: { wdaUrl: baseUrl, cause: cause ?? "connection failed" },
  });
}

export function wdaBaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.IOS_WDA_URL ?? env.WDA_URL ?? "http://localhost:8100";
}

interface WdaPayload {
  value?: unknown;
  sessionId?: unknown;
}

export class WdaClient {
  readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  private sessionId: string | null = null;

  constructor(opts: WdaClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? wdaBaseUrlFromEnv()).replace(/\/+$/, "");
    this.fetchFn = opts.fetchFn ?? defaultFetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  setSessionId(sid: string | null): void {
    this.sessionId = sid;
  }

  currentSessionId(): string | null {
    return this.sessionId;
  }

  /* ---------------------------- transport --------------------------- */

  private async raw(method: string, path: string, body?: unknown): Promise<{ status: number; payload: unknown }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: FetchResponse;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      const err = e as Error & { name?: string };
      if (err.name === "AbortError" || /abort/i.test(err.message ?? "")) {
        throw new ComputerUseError("timeout", `WDA ${method} ${path} timed out after ${this.timeoutMs}ms`, {
          details: { wdaUrl: this.baseUrl },
        });
      }
      throw wdaUnavailableError(this.baseUrl, err.message);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text().catch(() => "");
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { value: { message: text.slice(0, 500) } };
      }
    }
    if (!res.ok) {
      const value = (payload as WdaPayload | null)?.value;
      const msg =
        typeof value === "object" && value !== null && "message" in value
          ? String((value as { message: unknown }).message)
          : `HTTP ${res.status}`;
      const code = res.status === 404 && path.includes("/element") ? "element_not_found" : "provider_error";
      throw new ComputerUseError(code, `WDA ${method} ${path} failed (${res.status}): ${msg}`, {
        details: { status: res.status, url: `${this.baseUrl}${path}` },
      });
    }
    return { status: res.status, payload };
  }

  private value(payload: unknown): Record<string, unknown> {
    const v = (payload as WdaPayload | null)?.value;
    return (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const { payload } = await this.raw(method, path, body);
    return this.value(payload);
  }

  /* ----------------------------- session ---------------------------- */

  async status(): Promise<WdaStatus> {
    const v = await this.request("GET", "/status");
    const os = v.os as Record<string, unknown> | undefined;
    return {
      ready: v.ready === true,
      state: typeof v.state === "string" ? v.state : "unknown",
      osName: typeof os?.name === "string" ? os.name : undefined,
      osVersion: typeof os?.version === "string" ? os.version : undefined,
      raw: v,
    };
  }

  /** Probe + readiness check. Throws permission_required on unreachable or
   * not-ready WDA (never pretends the backend is healthy). */
  async assertReady(): Promise<WdaStatus> {
    const st = await this.status();
    if (!st.ready) {
      throw permissionRequired(`WebDriverAgent at ${this.baseUrl}`, WDA_SETUP_HINT, {
        details: { wdaUrl: this.baseUrl, state: st.state, ready: st.ready },
      });
    }
    return st;
  }

  /** Create a W3C session (or reuse the cached one). */
  async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const { payload } = await this.raw("POST", "/session", {
      capabilities: { alwaysMatch: {}, firstMatch: [{}] },
    });
    const fromValue = this.value(payload).sessionId;
    const top = (payload as WdaPayload | null)?.sessionId;
    const sid = typeof fromValue === "string" && fromValue ? fromValue : typeof top === "string" ? top : undefined;
    if (!sid) {
      throw new ComputerUseError("provider_error", "WDA /session returned no sessionId", {
        details: { payload: JSON.stringify(payload).slice(0, 300) },
      });
    }
    this.sessionId = sid;
    return sid;
  }

  async deleteSession(): Promise<void> {
    if (!this.sessionId) return;
    const sid = this.sessionId;
    this.sessionId = null;
    await this.raw("DELETE", `/session/${sid}`).catch(() => {});
  }

  /** Logical screen size in points. */
  async windowSize(): Promise<{ width: number; height: number }> {
    const sid = await this.ensureSession();
    const v = await this.request("GET", `/session/${sid}/window/size`);
    return { width: Number(v.width ?? 0), height: Number(v.height ?? 0) };
  }

  /* ------------------------------ tree ------------------------------ */

  /** Accessible element tree as JSON (frames in logical points). */
  async source(): Promise<WdaSourceNode | null> {
    const sid = await this.ensureSession();
    const v = await this.request("GET", `/session/${sid}/source?format=json`);
    return parseWdaSource(v);
  }

  async activeAppInfo(): Promise<{ name?: string; bundleId?: string; pid?: number }> {
    const sid = await this.ensureSession();
    const v = await this.request("GET", `/session/${sid}/wda/activeAppInfo`);
    return {
      name: typeof v.name === "string" ? v.name : undefined,
      bundleId: typeof v.bundleId === "string" ? v.bundleId : undefined,
      pid: typeof v.pid === "number" ? v.pid : undefined,
    };
  }

  /* ---------------------------- elements ---------------------------- */

  async findElements(using: string, value: string): Promise<string[]> {
    const sid = await this.ensureSession();
    const v = await this.request("POST", `/session/${sid}/elements`, { using, value });
    const list = Array.isArray(v) ? v : [];
    const ids: string[] = [];
    for (const item of list) {
      if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        const w3c = o["element-6066-11e4-a52e-4f735466cecf"];
        const legacy = o.ELEMENT;
        const id = typeof w3c === "string" ? w3c : typeof legacy === "string" ? legacy : undefined;
        if (id) ids.push(id);
      }
    }
    return ids;
  }

  async clickElement(elementId: string): Promise<void> {
    const sid = await this.ensureSession();
    await this.raw("POST", `/session/${sid}/element/${elementId}/click`, {});
  }

  /** Type text into an element (chars array per the MJSONWP wire format). */
  async elementValue(elementId: string, text: string): Promise<void> {
    const sid = await this.ensureSession();
    await this.raw("POST", `/session/${sid}/element/${elementId}/value`, { value: [...text] });
  }

  async elementClear(elementId: string): Promise<void> {
    const sid = await this.ensureSession();
    await this.raw("POST", `/session/${sid}/element/${elementId}/clear`, {});
  }

  /* --------------------------- coordinates -------------------------- */

  async tap(x: number, y: number): Promise<void> {
    const sid = await this.ensureSession();
    await this.raw("POST", `/session/${sid}/wda/tap/0`, { x, y });
  }

  async doubleTap(x: number, y: number): Promise<void> {
    const sid = await this.ensureSession();
    await this.raw("POST", `/session/${sid}/wda/doubleTap`, { x, y });
  }

  async touchAndHold(x: number, y: number, durationSec = 0.8): Promise<void> {
    const sid = await this.ensureSession();
    await this.raw("POST", `/session/${sid}/wda/touchAndHold`, { x, y, duration: durationSec });
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number, durationSec = 0.3): Promise<void> {
    const sid = await this.ensureSession();
    await this.raw("POST", `/session/${sid}/wda/dragfromtoforduration`, {
      fromX, fromY, toX, toY, duration: durationSec,
    });
  }

  async pressHome(): Promise<void> {
    const sid = await this.ensureSession();
    await this.raw("POST", `/session/${sid}/wda/pressHome`, {});
  }

  /** Type into the currently focused element. */
  async typeText(text: string): Promise<void> {
    const sid = await this.ensureSession();
    await this.raw("POST", `/session/${sid}/wda/type`, { value: text });
  }

  /** Send keyboard characters (subset the software keyboard can produce). */
  async keys(text: string): Promise<void> {
    const sid = await this.ensureSession();
    await this.raw("POST", `/session/${sid}/wda/keys`, { value: [...text] });
  }

  /* ------------------------------ apps ------------------------------ */

  async appLaunch(bundleId: string): Promise<void> {
    const sid = await this.ensureSession();
    await this.raw("POST", `/session/${sid}/wda/apps/launch`, { bundleId, shouldWait: true });
  }

  async appTerminate(bundleId: string): Promise<void> {
    const sid = await this.ensureSession();
    await this.raw("POST", `/session/${sid}/wda/apps/terminate`, { bundleId });
  }

  /** Installed apps: GET /wda/apps/list → { bundleId: {bundleDisplayName…} }. */
  async appsList(): Promise<Array<{ bundleId: string; name?: string }>> {
    const sid = await this.ensureSession();
    const v = await this.request("GET", `/session/${sid}/wda/apps/list`);
    const out: Array<{ bundleId: string; name?: string }> = [];
    for (const [bundleId, info] of Object.entries(v)) {
      if (!info || typeof info !== "object") continue;
      const o = info as Record<string, unknown>;
      const name =
        typeof o.bundleDisplayName === "string" ? o.bundleDisplayName :
        typeof o.bundleName === "string" ? o.bundleName : undefined;
      out.push({ bundleId, name });
    }
    return out;
  }

  async appActivate(bundleId: string): Promise<void> {
    const sid = await this.ensureSession();
    await this.raw("POST", `/session/${sid}/wda/apps/activate`, { bundleId });
  }

  async openUrl(url: string): Promise<void> {
    const sid = await this.ensureSession();
    await this.raw("POST", `/session/${sid}/url`, { url });
  }

  /* --------------------------- screenshot --------------------------- */

  /** Device-pixel PNG (base64 JSON value). */
  async screenshot(): Promise<Buffer> {
    const { payload } = await this.raw("GET", "/screenshot");
    const v = (payload as WdaPayload | null)?.value;
    if (typeof v !== "string" || v.length === 0) {
      throw new ComputerUseError("provider_error", "WDA /screenshot returned no image data");
    }
    return Buffer.from(v, "base64");
  }
}

/* ------------------------------------------------------------------ */
/* WDA JSON source parsing (pure, fixture-tested)                      */
/* ------------------------------------------------------------------ */

/** Parse a WDA `/source?format=json` value into a WdaSourceNode tree.
 * Tolerates frames as objects or CGRect description strings, and the
 * XCUIElementType-prefixed or bare type spellings. */
export function parseWdaSource(value: unknown): WdaSourceNode | null {
  if (value === null || value === undefined || typeof value !== "object") return null;
  return parseWdaNode(value as Record<string, unknown>);
}

function parseWdaNode(o: Record<string, unknown>): WdaSourceNode {
  const rawChildren = Array.isArray(o.children) ? o.children : [];
  const children: WdaSourceNode[] = [];
  for (const c of rawChildren) {
    if (c !== null && typeof c === "object") children.push(parseWdaNode(c as Record<string, unknown>));
  }
  const identifier = str(o.rawIdentifier) ?? str(o.identifier);
  const label = str(o.label);
  const name = str(o.name);
  return {
    role: normalizeIosRole(o.type ?? o.role),
    label: label ?? undefined,
    name: name ?? undefined,
    value: str(o.value) ?? undefined,
    identifier,
    frame: coerceFrame(o.frame),
    enabled: o.isEnabled === undefined ? true : o.isEnabled === true || o.isEnabled === "true" || o.isEnabled === 1,
    children,
    raw: o,
  };
}

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}
