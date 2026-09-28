/**
 * Windows UI Automation (UIA) tree — PowerShell + System.Windows.Automation.
 *
 * uia-tree.ps1 emits a flat, DFS-ordered JSON array of elements:
 *   { runtimeId, role ("ControlType.X"), name, value, enabled,
 *     bounds {x,y,width,height} | null (PHYSICAL screen pixels),
 *     patterns ["Invoke"|"Toggle"|"Value"|"ExpandCollapse"|"LegacyIAccessible"|...],
 *     depth, pid, className, autoId }
 *
 * The parsing / tree-building / locate logic below is PURE TypeScript so it
 * can be unit-tested on any OS with a recorded fixture (tests/unit/).
 */
import type { ElementRef, UINode } from "../../core/types.js";
import { ComputerUseError } from "../../core/errors.js";
import { encodeArgs, parsePsJson, runPowerShell } from "./powershell.js";

export interface UiaScope {
  /** top-level windows of this process id */
  pid?: number;
  /** resolve a process name to pids and walk its windows */
  processName?: string;
  /** exact Name of a top-level window */
  windowTitle?: string;
  /** walk the desktop root itself */
  desktopRoot?: boolean;
}

export interface UiaTreeOptions extends UiaScope {
  maxDepth?: number;
  maxNodes?: number;
}

export interface UiaBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One element exactly as emitted by uia-tree.ps1 (after sanitizing). */
export interface UiaElementJson {
  runtimeId: string;
  role: string;
  name: string;
  value: string;
  enabled: boolean;
  bounds: UiaBounds | null;
  patterns: string[];
  depth: number;
  pid?: number;
  className?: string;
  autoId?: string;
}

/** "ControlType.Button" -> "button" (macOS-style lowercase role names). */
export function normalizeRole(programmaticName: string): string {
  const r = (programmaticName ?? "").replace(/^ControlType\./i, "").trim().toLowerCase();
  return r || "unknown";
}

function asString(v: unknown, maxLen = 400): string {
  if (typeof v === "string") return v.length > maxLen ? v.slice(0, maxLen) : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function asNumber(v: unknown): number {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse the raw stdout of uia-tree.ps1. Tolerates trailing newlines and
 * CRLF; throws ComputerUseError("internal_error") when the payload is not
 * a JSON array (PS 5.1 \uXXXX escapes are handled by JSON.parse).
 */
export function parseUiTreeJson(raw: string): UiaElementJson[] {
  const text = (raw ?? "").trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ComputerUseError("internal_error", "uia-tree.ps1 output is not valid JSON", {
      details: { excerpt: text.slice(0, 400) },
      cause: e,
    });
  }
  if (!Array.isArray(parsed)) {
    throw new ComputerUseError("internal_error", "uia-tree.ps1 output is not a JSON array", {
      details: { excerpt: text.slice(0, 200) },
    });
  }
  const out: UiaElementJson[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const runtimeId = asString(o.runtimeId, 100);
    if (!runtimeId) continue; // dead/unreadable element — skip, don't fake
    const patternsRaw = Array.isArray(o.patterns) ? o.patterns : [];
    const boundsRaw = (o.bounds ?? null) as Record<string, unknown> | null;
    let bounds: UiaBounds | null = null;
    if (boundsRaw && typeof boundsRaw === "object") {
      bounds = {
        x: asNumber(boundsRaw.x),
        y: asNumber(boundsRaw.y),
        width: asNumber(boundsRaw.width),
        height: asNumber(boundsRaw.height),
      };
      if (bounds.width <= 0 || bounds.height <= 0) bounds = null;
    }
    out.push({
      runtimeId,
      role: asString(o.role, 60),
      name: asString(o.name),
      value: asString(o.value),
      enabled: o.enabled === undefined ? true : Boolean(o.enabled),
      bounds,
      patterns: patternsRaw.map((p) => asString(p, 40)).filter(Boolean),
      depth: Math.max(0, Math.round(asNumber(o.depth))),
      pid: o.pid === undefined || o.pid === null ? undefined : Math.round(asNumber(o.pid)),
      className: asString(o.className, 120) || undefined,
      autoId: asString(o.autoId, 200) || undefined,
    });
  }
  return out;
}

/** Rebuild the hierarchy from the flat DFS list using `depth`. */
export function buildUiForest(elements: UiaElementJson[]): UINode[] {
  const roots: UINode[] = [];
  const stack: { depth: number; node: UINode }[] = [];
  for (const el of elements) {
    const node = elementToNode(el);
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= el.depth) stack.pop();
    if (stack.length === 0) roots.push(node);
    else (stack[stack.length - 1]!.node.children ??= []).push(node);
    stack.push({ depth: el.depth, node });
  }
  return roots;
}

/** First root of the forest, or null. */
export function buildUiTree(elements: UiaElementJson[]): UINode | null {
  return buildUiForest(elements)[0] ?? null;
}

export function elementToNode(el: UiaElementJson): UINode {
  return {
    id: `uia:${el.runtimeId}`,
    source: "uia",
    role: normalizeRole(el.role),
    name: el.name || undefined,
    value: el.value || undefined,
    bounds: el.bounds ?? undefined,
    clickable: isClickable(el),
    editable: isEditable(el),
    enabled: el.enabled,
    attributes: {
      pid: el.pid ?? null,
      className: el.className ?? null,
      automationId: el.autoId ?? null,
      patterns: el.patterns.join("|"),
    },
  };
}

/** ElementRef for the adapter's locate()/executeAction() pipeline. */
export function elementToRef(el: UiaElementJson): ElementRef {
  return {
    id: `uia:${el.runtimeId}`,
    source: "uia",
    role: normalizeRole(el.role),
    name: el.name || undefined,
    value: el.value || undefined,
    bounds: el.bounds ?? undefined,
    clickable: isClickable(el),
    editable: isEditable(el),
    enabled: el.enabled,
    attributes: {
      pid: el.pid ?? null,
      className: el.className ?? null,
      automationId: el.autoId ?? null,
      patterns: el.patterns.join("|"),
    },
  };
}

const CLICKABLE_PATTERNS = new Set(["Invoke", "Toggle", "SelectionItem", "ExpandCollapse", "LegacyIAccessible"]);
const CLICKABLE_ROLES = new Set(["button", "hyperlink", "menuitem", "listitem", "tabitem", "checkbox", "radiobutton", "combobox", "splitbutton", "treeitem"]);

export function isClickable(el: UiaElementJson): boolean {
  if (el.patterns.some((p) => CLICKABLE_PATTERNS.has(p))) return true;
  return CLICKABLE_ROLES.has(normalizeRole(el.role));
}

export function isEditable(el: UiaElementJson): boolean {
  if (!el.patterns.includes("Value")) return false;
  const role = normalizeRole(el.role);
  return role === "edit" || role === "document" || role === "combobox" || role === "spinedit";
}

/** Find an element by its joined RuntimeId (accepts the `uia:` prefix form). */
export function findByRuntimeId(elements: UiaElementJson[], runtimeId: string): UiaElementJson | undefined {
  const want = runtimeId.replace(/^uia:/, "");
  return elements.find((el) => el.runtimeId === want);
}

export interface LocateDescriptor {
  role?: string;
  name?: string;
  text?: string;
  resourceId?: string;
  index?: number;
}

/** Pure matching logic shared by locate(): substring, case-insensitive. */
export function locateInElements(elements: UiaElementJson[], descriptor: LocateDescriptor): UiaElementJson | null {
  const wantName = (descriptor.name ?? descriptor.text ?? "").toLowerCase().trim();
  const wantRole = descriptor.role ? normalizeRole(descriptor.role) : null;
  const wantAutoId = descriptor.resourceId ?? null;
  const matches = elements.filter((el) => {
    if (wantRole) {
      const role = normalizeRole(el.role);
      if (role !== wantRole && !role.includes(wantRole) && !wantRole.includes(role)) return false;
    }
    if (wantAutoId && (el.autoId ?? "") !== wantAutoId) return false;
    if (wantName) {
      const nameLower = el.name.toLowerCase();
      if (!nameLower.includes(wantName) && !wantName.includes(nameLower)) return false;
    }
    return Boolean(wantName || wantRole || wantAutoId);
  });
  return matches[descriptor.index ?? 0] ?? null;
}

/** Center point of bounds — used by the coordinate fallback (physical px). */
export function centerOf(bounds: UiaBounds): { x: number; y: number } {
  return { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) };
}

/** Run uia-tree.ps1 and parse its output. */
export async function readUiTree(opts: UiaTreeOptions = {}): Promise<UiaElementJson[]> {
  const args = ["-ArgsJson", encodeArgs({ pid: opts.pid, processName: opts.processName, windowTitle: opts.windowTitle, desktopRoot: opts.desktopRoot })];
  if (opts.maxDepth !== undefined) args.push("-MaxDepth", String(opts.maxDepth));
  if (opts.maxNodes !== undefined) args.push("-MaxNodes", String(opts.maxNodes));
  const r = await runPowerShell("uia-tree.ps1", args, opts.maxNodes && opts.maxNodes > 600 ? 45_000 : 30_000);
  return parsePsJson<UiaElementJson[]>("uia-tree.ps1", r);
}

export interface UiaElementSignature {
  pid?: number | null;
  role?: string;
  name?: string;
  autoId?: string | null;
  className?: string | null;
  bounds?: UiaBounds | null;
}

export interface UiaActionRequest extends UiaScope {
  runtimeId: string;
  action: "invoke" | "toggle" | "setValue" | "select" | "expand" | "collapse" | "setFocus" | "readState" | "readBounds";
  value?: string;
  toggleValue?: boolean;
  /** fallback element signature — UIA RuntimeIds of non-hwnd elements can differ across client processes */
  sig?: UiaElementSignature;
}

export interface UiaActionResultJson {
  ok: boolean;
  runtimeId: string;
  action: string;
  matchedBy?: "runtimeId" | "signature";
  name?: string;
  value?: string;
  valueAfter?: string;
  enabled?: boolean;
  patterns?: string[];
  toggleState?: string;
  toggleBefore?: string;
  toggleAfter?: string;
  expandState?: string;
  unchanged?: boolean;
  invoked?: boolean;
  selected?: boolean;
  focused?: boolean;
  bounds?: UiaBounds | null;
}

/** Run uia-action.ps1 (semantic UIA pattern matched by RuntimeId, with a
 *  signature fallback for cross-process RuntimeId instability). */
export async function runUiaAction(req: UiaActionRequest, timeoutMs = 20_000): Promise<UiaActionResultJson> {
  const r = await runPowerShell(
    "uia-action.ps1",
    ["-ArgsJson", encodeArgs({
      runtimeId: req.runtimeId,
      action: req.action,
      value: req.value,
      toggleValue: req.toggleValue,
      sig: req.sig,
      pid: req.pid,
      processName: req.processName,
      windowTitle: req.windowTitle,
      desktopRoot: req.desktopRoot,
    })],
    timeoutMs,
  );
  return parsePsJson<UiaActionResultJson>("uia-action.ps1", r);
}
