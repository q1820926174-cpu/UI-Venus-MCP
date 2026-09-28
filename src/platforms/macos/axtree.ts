/**
 * macOS AX tree via System Events (AppleScript).
 *
 * Emits TSV lines: depth \t role \t name \t value \t x \t y \t w \t h \t path
 * where path is a "window[N]/<i>/<i>/..." chain resolvable back to
 * `UI element <i> of ...` references for semantic actions.
 *
 * Rationale: the raw AXUIElement C API via JXA is unreliable inside
 * sandboxed runtimes (-25201), while System Events works with the same
 * Accessibility grant.
 */
import { osascript } from "../exec.js";
import type { UINode } from "../../core/types.js";
import { ComputerUseError } from "../../core/errors.js";

export interface AxTreeOptions {
  processName?: string; // default: frontmost process
  windowIndex?: number; // default: all windows
  maxDepth?: number; // default 12
  maxNodes?: number; // default 200
}

export interface AxElement {
  depth: number;
  role: string;
  name: string;
  value: string;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  path: string; // e.g. "window[1]/2/5/1" — resolvable element path
}

const INTERACTIVE_ROLES = new Set([
  "AXButton", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton",
  "AXPopUpButton", "AXComboBox", "AXMenuButton", "AXSlider", "AXLink",
  "AXMenuItem", "AXSearchField", "AXTabGroup", "AXSwitch", "AXToggleButton",
  "AXStaticText", "AXImage", "AXRow", "AXCell", "AXMenuBarItem", "AXToolbar",
]);

export function buildScript(opts: Required<AxTreeOptions>): string {
  const proc = opts.processName ? JSON.stringify(opts.processName) : null;
  return `
using terms from application "System Events"
on escText(t)
  set t to t as text
  set AppleScript's text item delimiters to {return & linefeed, return, linefeed, tab}
  set parts to text items of t
  set AppleScript's text item delimiters to " "
  set t to parts as text
  set AppleScript's text item delimiters to ""
  return t
end escText

on walk(el, depth, maxDepth, pathStr)
  global collected
  global nodeCount
  global maxNodesGlobal
  if nodeCount ≥ maxNodesGlobal then return
  set r to ""
  try
    set r to role of el as text
  on error
    return
  end try
  set nodeCount to nodeCount + 1
  set n to ""
  try
    set n to my escText(name of el)
  end try
  set v to ""
  try
    set v to my escText(value of el)
  end try
  set px to ""
  set py to ""
  set pw to ""
  set ph to ""
  try
    set p to position of el
    set px to (item 1 of p) as text
    set py to (item 2 of p) as text
    set s to size of el
    set pw to (item 1 of s) as text
    set ph to (item 2 of s) as text
  end try
  set end of collected to (depth as text) & tab & r & tab & n & tab & v & tab & px & tab & py & tab & pw & tab & ph & tab & pathStr
  if depth < maxDepth then
    try
      set kids to UI elements of el
      set kidCount to count of kids
      repeat with i from 1 to kidCount
        if nodeCount ≥ maxNodesGlobal then exit repeat
        my walk(item i of kids, depth + 1, maxDepth, pathStr & "/" & i)
      end repeat
    end try
  end if
end walk

global collected
global nodeCount
global maxNodesGlobal
set collected to {}
set nodeCount to 0
set maxNodesGlobal to ${opts.maxNodes}
tell application "System Events"
  ${
    proc
      ? `if not (exists process ${proc}) then return "PROCESS_NOT_FOUND"
  set targetProcess to process ${proc}`
      : `set targetProcess to first process whose frontmost is true`
  }
  set winList to windows of targetProcess
  ${
    opts.windowIndex
      ? `set winList to {item ${opts.windowIndex} of winList}
  my walk(item 1 of winList, 1, ${opts.maxDepth}, "window[1]")`
      : `repeat with wi from 1 to count of winList
    my walk(item wi of winList, 1, ${opts.maxDepth}, "window[" & wi & "]")
  end repeat`
  }
end tell
set AppleScript's text item delimiters to linefeed
return collected as text
end using terms from
`;
}

export async function readAxTree(opts: AxTreeOptions = {}): Promise<AxElement[]> {
  const full: Required<AxTreeOptions> = {
    processName: opts.processName ?? "",
    windowIndex: opts.windowIndex ?? 0,
    maxDepth: opts.maxDepth ?? 12,
    maxNodes: opts.maxNodes ?? 200,
  };
  const raw = await osascript(buildScript(full), 30_000);
  if (raw.trim() === "PROCESS_NOT_FOUND") {
    throw new ComputerUseError("element_not_found", `Process not found: ${full.processName}`);
  }
  const elements: AxElement[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    if (cols.length < 9) continue;
    const clean = (s: string | undefined): string => (s === undefined || s === "missing value" ? "" : s);
    elements.push({
      depth: Number.parseInt(cols[0]!, 10),
      role: cols[1] ?? "",
      name: clean(cols[2]),
      value: clean(cols[3]),
      x: cols[4] ? Number(cols[4]) : null,
      y: cols[5] ? Number(cols[5]) : null,
      width: cols[6] ? Number(cols[6]) : null,
      height: cols[7] ? Number(cols[7]) : null,
      path: cols[8] ?? "",
    });
  }
  return elements;
}

/** Convert AX elements into a UINode tree (bounds in logical points). */
export function axToTree(elements: AxElement[]): UINode | null {
  const roots: UINode[] = [];
  const stack: { depth: number; node: UINode }[] = [];
  for (const el of elements) {
    const node: UINode = {
      id: `ax:${el.path}`,
      source: "ax",
      role: normalizeRole(el.role),
      name: el.name || undefined,
      value: el.value || undefined,
      bounds:
        el.x !== null && el.y !== null && el.width !== null && el.height !== null
          ? { x: el.x, y: el.y, width: el.width, height: el.height }
          : undefined,
      clickable: INTERACTIVE_ROLES.has(el.role) && el.role !== "AXStaticText",
      enabled: true,
      attributes: { axRole: el.role },
    };
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= el.depth) stack.pop();
    if (stack.length === 0) roots.push(node);
    else (stack[stack.length - 1]!.node.children ??= []).push(node);
    stack.push({ depth: el.depth, node });
  }
  return roots[0] ?? null;
}

function normalizeRole(axRole: string): string {
  return axRole.replace(/^AX/, "").toLowerCase() || "unknown";
}

/**
 * Build an AppleScript reference for a path like "window[1]/2/5/1".
 * First segment resolves as `window <i>` (process UI elements also include
 * the menu bar, so generic indexing would be ambiguous); deeper numeric
 * segments resolve as generic `UI element <i>` matching traversal order.
 */
export function pathToReference(path: string): string {
  const segs = path.split("/").filter(Boolean);
  const first = segs[0]?.match(/^window\[(\d+)\]$/);
  if (!first) return "";
  let ref = `window ${first[1]}`;
  for (const seg of segs.slice(1)) {
    if (!/^\d+$/.test(seg)) continue;
    ref = `UI element ${seg} of ${ref}`;
  }
  return ref;
}

/** Perform a semantic click on an element path inside a process. */
export async function axClick(processName: string, path: string): Promise<void> {
  const ref = pathToReference(path);
  await osascript(
    `tell application "System Events" to click ${ref} of process ${JSON.stringify(processName)}`,
    15_000,
  );
}

export async function axSetValue(processName: string, path: string, value: string): Promise<void> {
  const ref = pathToReference(path);
  const escaped = JSON.stringify(value);
  await osascript(
    `tell application "System Events" to set value of ${ref} of process ${JSON.stringify(processName)} to ${escaped}`,
    15_000,
  );
}

export async function axGetAttributes(processName: string, path: string): Promise<{ checked?: boolean; value?: string; focused?: boolean }> {
  const ref = pathToReference(path);
  const script = `
tell application "System Events"
  set el to ${ref} of process ${JSON.stringify(processName)}
  set out to ""
  try
    set out to out & "value=" & (value of el as text)
  on error
    set out to out & "value="
  end try
  try
    if (value of attribute "AXMenuItemMarkChar" of el) is missing value then
      set out to out & "|checked=unknown"
    else
      set out to out & "|checked=true"
    end if
  on error
    set out to out & "|checked=unknown"
  end try
  return out
end tell`;
  const raw = await osascript(script, 10_000);
  const result: { checked?: boolean; value?: string; focused?: boolean } = {};
  for (const part of raw.split("|")) {
    const [k, ...rest] = part.split("=");
    const v = rest.join("=");
    if (k === "value") result.value = v;
    if (k === "checked") result.checked = v === "true" ? true : v === "unknown" ? undefined : false;
  }
  return result;
}

export { INTERACTIVE_ROLES };
