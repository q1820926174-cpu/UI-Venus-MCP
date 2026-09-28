/**
 * AT-SPI2 accessibility tree for Linux (X11 and Wayland) via python3/pyatspi.
 *
 * One small python script is embedded and passed through `python3 -c <script>
 * <subcommand> …`. It emits one JSON object per line on stdout:
 *   walk     → one record per accessible node (depth/role/name/states/extents…)
 *   act      → {"ok":…, "action":…} after queryAction().doAction(i)
 *   settext  → {"ok":…} after queryText().setTextContents(value)
 *
 * The TS parser for those JSON lines is pure and tested without Linux.
 * Element identity is a stable path of child indexes from the desktop:
 *   "<appIndex>/<childIndex>/<childIndex>/…"
 * The `act`/`settext` subcommands re-navigate the same path in a fresh
 * process (the tree must not be reshuffled between the walk and the action).
 *
 * NOTE: AT-SPI component extents (getExtents(DESKTOP_COORDS)) are screen
 * pixels of the X screen — on X11 that equals our logical pixel space (scale
 * 1); on Wayland some toolkits report unreliable extents, which the adapter
 * surfaces honestly by dropping bounds instead of guessing.
 */
import type { UINode } from "../../core/types.js";

export interface AtspiStates {
  enabled?: boolean;
  checked?: boolean;
  focused?: boolean;
  editable?: boolean;
  selected?: boolean;
  visible?: boolean;
}

export interface AtspiNode {
  depth: number;
  /** child-index path from the desktop, first segment = application index */
  path: string;
  /** raw AT-SPI role name, e.g. "push button" */
  role: string;
  name: string;
  description: string;
  /** application (process) name if known */
  app: string;
  states: AtspiStates;
  /** screen-pixel extents from Component.getExtents(DESKTOP_COORDS) */
  extents: { x: number; y: number; width: number; height: number } | null;
  /** text content (Text interface), truncated to 2000 chars by the walker */
  text: string | null;
  /** Action interface action names, e.g. ["press"] */
  actions: string[];
}

/**
 * The embedded python3 walker/actor. Subcommands:
 *   walk [--app NAME] [--max-depth N] [--max-nodes N]
 *   act <path>
 *   settext <path> <value>
 */
export const ATSPI_SCRIPT = String.raw`
import sys, json

def out(o):
    sys.stdout.write(json.dumps(o, ensure_ascii=False) + "\n")

def safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default

def states_of(pa, obj):
    def one():
        st = obj.getState()
        def has(s):
            try:
                return st.contains(s)
            except Exception:
                return False
        return {
            "enabled": bool(has(pa.STATE_ENABLED) and has(pa.STATE_SENSITIVE)),
            "checked": bool(has(pa.STATE_CHECKED)),
            "focused": bool(has(pa.STATE_FOCUSED)),
            "editable": bool(has(pa.STATE_EDITABLE)),
            "selected": bool(has(pa.STATE_SELECTED)),
            "visible": bool(has(pa.STATE_VISIBLE)),
        }
    return safe(one, {})

def extents_of(obj):
    # pyatspi.DESKTOP_COORDS == 0: screen pixels of the X screen
    def one():
        c = obj.queryComponent()
        e = c.getExtents(0)
        return [e.x, e.y, e.width, e.height]
    return safe(one)

def text_of(obj):
    def one():
        t = obj.queryText()
        n = min(t.characterCount, 2000)
        if n <= 0:
            return ""
        return t.getText(0, n)
    return safe(one)

def actions_of(obj):
    def one():
        a = obj.queryAction()
        return [a.getName(i) for i in range(a.nActions())]
    return safe(one, [])

def record(pa, obj, depth, path):
    role = safe(lambda: obj.getRoleName(), "")
    name = safe(lambda: obj.name, "")
    desc = safe(lambda: obj.description, "")
    app = safe(lambda: obj.getApplicationName(), "")
    return {
        "d": depth,
        "p": path,
        "role": role,
        "name": name,
        "desc": desc,
        "app": app,
        "st": states_of(pa, obj),
        "ext": extents_of(obj),
        "text": text_of(obj),
        "acts": actions_of(obj),
    }

def walk(pa, obj, depth, path, maxdepth, counter, maxnodes):
    if counter[0] >= maxnodes:
        return
    counter[0] += 1
    out(record(pa, obj, depth, path))
    if depth >= maxdepth:
        return
    n = safe(lambda: obj.childCount, 0) or 0
    for i in range(n):
        if counter[0] >= maxnodes:
            return
        child = safe(lambda: obj.getChildAtIndex(i))
        if child is None:
            continue
        walk(pa, child, depth + 1, path + "/" + str(i), maxdepth, counter, maxnodes)

def node_at(desktop, path):
    node = desktop
    for seg in [s for s in path.split("/") if s != ""]:
        nxt = safe(lambda: node.getChildAtIndex(int(seg)))
        if nxt is None:
            return None
        node = nxt
    return node

PREFER_ACTIONS = ("press", "click", "toggle", "activate", "open", "select")

def main():
    argv = sys.argv[1:]
    cmd = argv[0] if argv else "walk"
    try:
        import pyatspi as pa
    except Exception as e:
        out({"ok": False, "error": "pyatspi import failed: " + str(e)})
        return
    try:
        desktop = pa.Registry.getDesktop(0)
    except Exception as e:
        out({"ok": False, "error": "accessibility bus unavailable: " + str(e)})
        return

    if cmd == "walk":
        appfilter = None
        maxdepth, maxnodes = 12, 400
        i = 1
        while i < len(argv):
            if argv[i] == "--app" and i + 1 < len(argv):
                appfilter = argv[i + 1]
                i += 2
            elif argv[i] == "--max-depth" and i + 1 < len(argv):
                maxdepth = int(argv[i + 1])
                i += 2
            elif argv[i] == "--max-nodes" and i + 1 < len(argv):
                maxnodes = int(argv[i + 1])
                i += 2
            else:
                i += 1
        counter = [0]
        n = safe(lambda: desktop.childCount, 0) or 0
        for ai in range(n):
            if counter[0] >= maxnodes:
                break
            app = safe(lambda: desktop.getChildAtIndex(ai))
            if app is None:
                continue
            if appfilter:
                an = (safe(lambda: app.name, "") or "").lower()
                if appfilter.lower() not in an:
                    continue
            walk(pa, app, 0, str(ai), maxdepth, counter, maxnodes)
    elif cmd == "act":
        path = argv[1] if len(argv) > 1 else ""
        node = safe(lambda: node_at(desktop, path))
        if node is None:
            out({"ok": False, "error": "no accessible element at path " + path})
            return
        acts = actions_of(node)
        if not acts:
            out({"ok": False, "error": "element exposes no AT-SPI Action interface"})
            return
        idx = 0
        for j, nm in enumerate(acts):
            if str(nm).lower() in PREFER_ACTIONS:
                idx = j
                break
        done = safe(lambda: node.queryAction().doAction(idx), False)
        out({"ok": bool(done), "action": str(acts[idx]), "index": idx, "acts": acts})
    elif cmd == "settext":
        path = argv[1] if len(argv) > 1 else ""
        value = argv[2] if len(argv) > 2 else ""
        node = safe(lambda: node_at(desktop, path))
        if node is None:
            out({"ok": False, "error": "no accessible element at path " + path})
            return
        done = safe(lambda: node.queryText().setTextContents(value), False)
        out({"ok": bool(done)})
    else:
        out({"ok": False, "error": "unknown subcommand " + cmd})

main()
`;

/** argv suffix for `python3 -c <ATSPI_SCRIPT> …` that walks the tree. */
export function buildAtspiWalkArgs(
  opts: { app?: string; maxDepth?: number; maxNodes?: number } = {},
): string[] {
  const args = ["-c", ATSPI_SCRIPT, "walk", "--max-depth", String(opts.maxDepth ?? 12), "--max-nodes", String(opts.maxNodes ?? 400)];
  if (opts.app) args.push("--app", opts.app);
  return args;
}

/** argv suffix for a semantic Action.doAction at a tree path. */
export function buildAtspiActArgs(path: string): string[] {
  return ["-c", ATSPI_SCRIPT, "act", path];
}

/** argv suffix for Text.setTextContents at a tree path. */
export function buildAtspiSetTextArgs(path: string, value: string): string[] {
  return ["-c", ATSPI_SCRIPT, "settext", path, value];
}

// ---------------------------------------------------------------------------
// Pure TS parsing of the walker's JSON-lines output
// ---------------------------------------------------------------------------

export interface AtspiParseResult {
  nodes: AtspiNode[];
  /** error records ({ok:false,error}) / unparseable lines */
  errors: string[];
}

/** Parse one JSON object per line. Never throws. */
export function parseAtspiNodes(stdout: string): AtspiParseResult {
  const nodes: AtspiNode[] = [];
  const errors: string[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(t) as Record<string, unknown>;
    } catch {
      errors.push(`unparseable AT-SPI line: ${t.slice(0, 160)}`);
      continue;
    }
    if (typeof rec.error === "string") {
      errors.push(rec.error);
      continue;
    }
    if (typeof rec.role !== "string" || typeof rec.p !== "string") continue;
    const st = (rec.st ?? {}) as Record<string, unknown>;
    const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
    const extRaw: unknown = rec.ext;
    const isExt =
      Array.isArray(extRaw) &&
      extRaw.length === 4 &&
      extRaw.every((n) => typeof n === "number" && Number.isFinite(n));
    nodes.push({
      depth: typeof rec.d === "number" && Number.isFinite(rec.d) ? rec.d : 0,
      path: rec.p,
      role: rec.role,
      name: typeof rec.name === "string" ? rec.name : "",
      description: typeof rec.desc === "string" ? rec.desc : "",
      app: typeof rec.app === "string" ? rec.app : "",
      states: {
        enabled: bool(st.enabled),
        checked: bool(st.checked),
        focused: bool(st.focused),
        editable: bool(st.editable),
        selected: bool(st.selected),
        visible: bool(st.visible),
      },
      extents: isExt
        ? {
            x: (extRaw as number[])[0]!,
            y: (extRaw as number[])[1]!,
            width: (extRaw as number[])[2]!,
            height: (extRaw as number[])[3]!,
          }
        : null,
      text: typeof rec.text === "string" ? rec.text : null,
      actions: Array.isArray(rec.acts) ? (rec.acts as unknown[]).filter((a): a is string => typeof a === "string") : [],
    });
  }
  return { nodes, errors };
}

export interface AtspiActionResult {
  ok: boolean;
  error?: string;
  action?: string;
  index?: number;
  actions?: string[];
}

/** Parse the single-record output of `act` / `settext` subcommands. */
export function parseAtspiResult(stdout: string): AtspiActionResult {
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as Record<string, unknown>;
      return {
        ok: rec.ok === true,
        error: typeof rec.error === "string" ? rec.error : undefined,
        action: typeof rec.action === "string" ? rec.action : undefined,
        index: typeof rec.index === "number" ? rec.index : undefined,
        actions: Array.isArray(rec.acts)
          ? (rec.acts as unknown[]).filter((a): a is string => typeof a === "string")
          : undefined,
      };
    } catch {
      // skip non-JSON noise and keep looking
    }
  }
  return { ok: false, error: `no parsable AT-SPI result in output: ${stdout.slice(0, 200) || "(empty)"}` };
}

// ---------------------------------------------------------------------------
// Role normalization (AT-SPI role name → unified role)
// ---------------------------------------------------------------------------

const ROLE_MAP: Record<string, string> = {
  "push button": "button",
  "toggle button": "togglebutton",
  "check box": "checkbox",
  "radio button": "radio",
  "menu item": "menuitem",
  "check menu item": "checkmenuitem",
  "radio menu item": "radiomenuitem",
  text: "textfield",
  "password text": "password",
  entry: "textfield",
  label: "label",
  heading: "heading",
  paragraph: "paragraph",
  link: "link",
  image: "image",
  icon: "image",
  "combo box": "combobox",
  list: "list",
  "list item": "listitem",
  menu: "menu",
  "menu bar": "menubar",
  "scroll bar": "scrollbar",
  "scroll pane": "scrollpane",
  slider: "slider",
  "spin button": "spinbutton",
  "page tab": "tab",
  "page tab list": "tablist",
  table: "table",
  "table cell": "cell",
  "table row": "row",
  "table column header": "columnheader",
  "tree item": "treeitem",
  "tree table": "treetable",
  frame: "window",
  window: "window",
  dialog: "dialog",
  alert: "alert",
  notification: "notification",
  panel: "panel",
  "root pane": "pane",
  "split pane": "pane",
  "status bar": "statusbar",
  "tool bar": "toolbar",
  "tool tip": "tooltip",
  "progress bar": "progressbar",
  separator: "separator",
  document: "document",
  "document web": "document",
  "document text": "document",
  application: "application",
  "desktop frame": "desktop",
  section: "section",
  filler: "filler",
  embedded: "embedded",
};

const CLICKABLE_ROLES = new Set([
  "button",
  "togglebutton",
  "checkbox",
  "radio",
  "menuitem",
  "checkmenuitem",
  "radiomenuitem",
  "tab",
  "link",
  "combobox",
  "listitem",
  "treeitem",
  "spinbutton",
  "slider",
]);

/** AT-SPI role name ("push button") → unified role ("button"). */
export function normalizeAtspiRole(role: string): string {
  const key = role.trim().toLowerCase();
  const mapped = ROLE_MAP[key];
  if (mapped) return mapped;
  const cleaned = key.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "unknown";
}

/** Roles treated clickable even without an AT-SPI Action entry. */
export function isClickableRole(normalizedRole: string): boolean {
  return CLICKABLE_ROLES.has(normalizedRole);
}

/**
 * Build a UINode tree from the flat depth-ordered node list
 * (bounds are AT-SPI screen pixels == logical pixels at scale 1).
 */
export function atspiToTree(nodes: AtspiNode[]): UINode | null {
  const roots: UINode[] = [];
  const stack: { depth: number; node: UINode }[] = [];
  for (const n of nodes) {
    const role = normalizeAtspiRole(n.role);
    const node: UINode = {
      id: `atspi:${n.path}`,
      source: "atspi",
      role,
      name: n.name || undefined,
      value: n.text || undefined,
      description: n.description || undefined,
      bounds: n.extents ? { ...n.extents } : undefined,
      clickable: n.actions.length > 0 || isClickableRole(role),
      editable: n.states.editable === true ? true : n.states.editable === false ? false : undefined,
      enabled: n.states.enabled,
      checked: n.states.checked,
      selected: n.states.selected,
      focused: n.states.focused,
      attributes: { app: n.app, atspiRole: n.role, atspiPath: n.path, actions: n.actions.join(",") },
    };
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= n.depth) stack.pop();
    if (stack.length === 0) roots.push(node);
    else (stack[stack.length - 1]!.node.children ??= []).push(node);
    stack.push({ depth: n.depth, node });
  }
  return roots[0] ?? null;
}
