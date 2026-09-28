/**
 * uiautomator XML dump parser — no dependencies (hand-written XML reader).
 *
 * `adb shell uiautomator dump /sdcard/window_dump.xml` produces a single
 * <hierarchy rotation="…"> of nested <node …/> elements. Each node carries
 * bounds in PHYSICAL pixels plus class/clickability attributes. This module
 * parses that XML into the unified UINode tree and gives every node a
 * STABLE PATH identity (`uia:<i>/<j>/…`, indexes into the dump tree) that
 * the adapter re-resolves in a FRESH dump right before acting.
 */
import type { Rect, UINode, ElementRef } from "../../core/types.js";

/** Minimal parsed XML element. */
export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (ent, code: string) => {
    if (code.startsWith("#")) {
      const num =
        code[1] === "x" || code[1] === "X"
          ? Number.parseInt(code.slice(2), 16)
          : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(num) ? String.fromCodePoint(num) : ent;
    }
    switch (code) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        return ent;
    }
  });
}

/** Index of the ">" that closes the tag starting at `start`, honoring quoted attribute values. */
function findTagEnd(xml: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let i = start + 1; i < xml.length; i++) {
    const ch = xml[i]!;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return xml.length;
}

function parseTag(body: string): { name: string; attrs: Record<string, string> } {
  const nameMatch = body.match(/^\s*([^\s/>]+)/);
  const attrs: Record<string, string> = {};
  const attrRe = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(body)) !== null) {
    attrs[m[1]!] = decodeEntities(m[2] ?? m[3] ?? "");
  }
  return { name: nameMatch?.[1] ?? "", attrs };
}

/** Parse a (small, machine-generated) XML document. Never throws on stray text. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0;
  const len = xml.length;
  while (i < len) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) break;
    const text = xml.slice(i, lt);
    if (text.trim()) stack[stack.length - 1]!.text += decodeEntities(text.trim());
    i = lt;
    if (xml.startsWith("<?", i) || xml.startsWith("<!", i)) {
      const end = xml.indexOf(">", i);
      i = end < 0 ? len : end + 1;
      continue;
    }
    if (xml.startsWith("<!--", i)) {
      const end = xml.indexOf("-->", i);
      i = end < 0 ? len : end + 3;
      continue;
    }
    if (xml.startsWith("</", i)) {
      const end = xml.indexOf(">", i);
      if (stack.length > 1) stack.pop();
      i = end < 0 ? len : end + 1;
      continue;
    }
    const end = findTagEnd(xml, i);
    const tag = xml.slice(i + 1, end);
    i = end + 1;
    const selfClose = tag.trimEnd().endsWith("/");
    const body = selfClose ? tag.trimEnd().slice(0, -1) : tag;
    const { name, attrs } = parseTag(body);
    if (!name) continue;
    const node: XmlNode = { name, attrs, children: [], text: "" };
    stack[stack.length - 1]!.children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

const ROLE_BY_CLASS: Record<string, string> = {
  "android.widget.Button": "button",
  "android.widget.ImageButton": "button",
  "android.widget.ToggleButton": "button",
  "android.widget.EditText": "textfield",
  "android.widget.CheckBox": "checkbox",
  "android.widget.CheckedTextView": "checkbox",
  "android.widget.Switch": "switch",
  "android.widget.RadioButton": "radio",
  "android.widget.SeekBar": "slider",
  "android.widget.RatingBar": "slider",
  "android.widget.TextView": "text",
  "android.widget.ImageView": "image",
  "android.widget.ListView": "list",
  "android.widget.GridView": "list",
  "android.widget.ScrollView": "list",
  "android.widget.HorizontalScrollView": "list",
  "androidx.recyclerview.widget.RecyclerView": "list",
  "androidx.viewpager.widget.ViewPager": "list",
  "android.webkit.WebView": "webview",
};

/** Map a fully-qualified Android class to a unified role. Falls back to the class' last segment. */
export function classToRole(cls: string): string {
  if (!cls) return "unknown";
  const exact = ROLE_BY_CLASS[cls];
  if (exact) return exact;
  const last = cls.split(".").pop() ?? cls;
  const suffix = last.toLowerCase();
  if (suffix.endsWith("button")) return "button";
  if (suffix.endsWith("edittext")) return "textfield";
  if (suffix.endsWith("checkbox")) return "checkbox";
  if (suffix.endsWith("switch")) return "switch";
  if (suffix.endsWith("textview")) return "text";
  if (suffix.endsWith("imageview")) return "image";
  if (suffix.endsWith("recyclerview") || suffix.endsWith("listview") || suffix.endsWith("scrollview")) return "list";
  if (suffix.endsWith("webview")) return "webview";
  return suffix || "unknown";
}

/** "[x1,y1][x2,y2]" → Rect in physical pixels. */
export function parseBounds(s: string): Rect | undefined {
  const m = s.match(/^\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]$/);
  if (!m) return undefined;
  const x1 = Number(m[1]);
  const y1 = Number(m[2]);
  const x2 = Number(m[3]);
  const y2 = Number(m[4]);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return undefined;
  return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
}

/** Center of a rect in the same coordinate space (physical pixels). */
export function centerOf(rect: Rect): { x: number; y: number } {
  return { x: rect.x + Math.floor(rect.width / 2), y: rect.y + Math.floor(rect.height / 2) };
}

function xmlNodeToUINode(xml: XmlNode, path: string): UINode {
  const a = xml.attrs;
  const cls = a.class ?? "";
  const text = a.text ?? "";
  const desc = a["content-desc"] ?? "";
  const rid = a["resource-id"] ?? "";
  const node: UINode = {
    id: `uia:${path}`,
    source: "uiautomator",
    role: classToRole(cls),
    name: text || desc || rid || undefined,
    value: text || undefined,
    description: desc || undefined,
    bounds: parseBounds(a.bounds ?? ""),
    clickable: a.clickable === "true",
    editable: /EditText$/.test(cls),
    enabled: a.enabled !== "false",
    checked: a.checked === "true",
    selected: a.selected === "true",
    focused: a.focused === "true",
    attributes: {
      class: cls || null,
      "resource-id": rid || null,
      package: a.package ?? null,
      index: Number(Number.parseInt(a.index ?? "0", 10) || 0),
      scrollable: a.scrollable === "true",
      longClickable: a["long-clickable"] === "true",
      password: a.password === "true",
    },
    children: xml.children.map((c, idx) => xmlNodeToUINode(c, `${path}/${idx}`)),
  };
  return node;
}

/**
 * Parse a `uiautomator dump` document into a UINode tree. Returns null when
 * the payload contains no hierarchy. The device rotation from
 * `<hierarchy rotation="N">` lands on the root node's attributes.
 */
export function parseDump(xml: string): UINode | null {
  if (!xml.includes("<node") && !xml.includes("<hierarchy")) return null;
  const doc = parseXml(xml);
  const hierarchy = doc.children.find((c) => c.name === "hierarchy") ?? doc;
  const first = hierarchy.children.find((c) => c.name === "node");
  if (!first) {
    // tolerate a bare <node> document (hand-written fixtures/tests)
    if (hierarchy.name === "node") return xmlNodeToUINode(hierarchy, "0");
    return null;
  }
  const root = xmlNodeToUINode(first, "0");
  const rotation = Number.parseInt(hierarchy.attrs.rotation ?? "", 10);
  root.attributes = { ...root.attributes, rotation: Number.isFinite(rotation) ? rotation : null };
  return root;
}

/** Descriptor for `findBy` — every specified field must match (AND). */
export interface DumpQuery {
  /** exact resource-id; also accepts the bare id suffix ("save_button" matches "com.x:id/save_button") */
  resourceId?: string;
  /** substring match against node text */
  text?: string;
  /** substring match against content-desc */
  contentDesc?: string;
  /** substring match against node name (text or content-desc) */
  name?: string;
  /** unified role (button/textfield/switch/…) */
  role?: string;
  /** exact android class match */
  class?: string;
  /** which match to pick (after filtering) */
  index?: number;
}

function matches(n: UINode, q: DumpQuery): boolean {
  if (q.resourceId) {
    const rid = String(n.attributes?.["resource-id"] ?? "");
    if (rid !== q.resourceId && !rid.endsWith(`/${q.resourceId}`)) return false;
  }
  if (q.class && n.attributes?.class !== q.class) return false;
  if (q.role && n.role !== q.role) return false;
  if (q.text && !(n.value ?? "").includes(q.text)) return false;
  if (q.contentDesc && !(n.description ?? "").includes(q.contentDesc)) return false;
  if (q.name && !(n.name ?? "").toLowerCase().includes(q.name.toLowerCase())) return false;
  return true;
}

/** Depth-first (document order) search. An empty query matches nothing; `index` picks the nth match. */
export function findBy(root: UINode, q: DumpQuery): UINode[] {
  const { index: pickIndex, ...criteria } = q;
  const hasCriteria = Object.values(criteria).some((v) => v !== undefined && v !== null && v !== "");
  if (!hasCriteria) return [];
  const out: UINode[] = [];
  const walk = (n: UINode): void => {
    if (matches(n, criteria)) out.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  if (pickIndex === undefined) return out;
  const pick = out[pickIndex];
  return pick ? [pick] : [];
}

/** Resolve a stable path ("0", "0/1/2") into the dump tree; null when out of range. */
export function resolveNode(root: UINode, path: string): UINode | null {
  const segs = path.split("/").filter(Boolean);
  if (segs.length === 0 || segs[0] !== "0") return null;
  let cur: UINode = root;
  for (const seg of segs.slice(1)) {
    const idx = Number.parseInt(seg, 10);
    const child = cur.children?.[idx];
    if (!child) return null;
    cur = child;
  }
  return cur;
}

/** Does a freshly-dumped node still look like the element captured earlier? */
export function nodeStillMatches(n: UINode, el: ElementRef): boolean {
  const rid = el.attributes?.["resource-id"];
  if (typeof rid === "string" && rid && n.attributes?.["resource-id"] === rid) return true;
  if (el.value !== undefined && el.value !== "" && n.value === el.value) return true;
  if (el.description !== undefined && el.description !== "" && n.description === el.description) return true;
  return false;
}

/** Strip children for use as an ElementRef (evidence / fusion currency). */
export function toElementRef(n: UINode): ElementRef {
  const { children: _children, ...rest } = n;
  return rest;
}
