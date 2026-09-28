/**
 * Browser adapter (spec §11/§12) — Playwright-backed implementation of
 * PlatformAdapter for a live browser session.
 *
 * Design notes:
 *  - Playwright is an OPTIONAL dependency: it is imported dynamically so
 *    the MCP still builds/runs without it, and the failure mode is an
 *    honest "unsupported: playwright not installed" instead of a crash.
 *  - STRUCTURED-FIRST locators, exact priority: role+accessible name →
 *    text → test id (CUMCP_TEST_ID_ATTR, default data-testid) → CSS →
 *    XPath fallback. The generated ElementRef.id IS the playwright
 *    selector key ("role=button[name=\"登录\"]", "testid=…", "css=#…"),
 *    so actions re-resolve elements with page.locator(id).
 *  - UI tree: `page.accessibility.snapshot()` was removed in Playwright
 *    1.5x+, so the tree is built from `locator.ariaSnapshot()` (YAML),
 *    parsed with the shared `yaml` dependency. The same snapshot string
 *    is reported as Observation.dom.
 *  - Coordinates: the page viewport is the only "display". Screenshot
 *    space == CSS px * deviceScaleFactor (default 1 → identical). ElementRef
 *    bounds follow the core contract (screenshot pixel space of the
 *    observation); with the default scale factor that is exactly the
 *    viewport CSS pixel rect from locator.boundingBox().
 *  - Sessions: one adapter = one browser context. Tabs (pages) are kept
 *    in a list; focus(windowTitle) switches the ACTIVE page and
 *    observe/screenshot act on it. launch_app is honestly unsupported.
 *  - JS dialogs (alert/confirm/prompt) are auto-accepted and logged so
 *    automation never stalls on them.
 */
import { parse as parseYaml } from "yaml";
import type {
  AppInfo,
  Capabilities,
  ElementRef,
  Observation,
  Point,
  ScreenInfo,
  Screenshot,
  Target,
  TargetInfo,
  UINode,
  WindowInfo,
} from "../../core/types.js";
import type { Action, ActionResult } from "../../core/types-action.js";
import { ComputerUseError, unsupported } from "../../core/errors.js";
import { processScreenshot } from "../../screenshot/pipeline.js";
import type {
  LaunchOptions,
  ObserveOptions,
  PlatformAdapter,
  ScreenshotOptions,
} from "../adapter.js";
// Type-only import: erased at runtime, so playwright staying optional is safe.
import type { Browser, BrowserContext, Dialog, Locator, Page } from "playwright";

type PlaywrightModule = typeof import("playwright");
type BrowserName = "chromium" | "firefox" | "webkit";
/** Playwright's strict ARIA-role union (unified roles are free-form strings). */
type PlaywrightAriaRole = Parameters<Page["getByRole"]>[0];

const BROWSERS: readonly BrowserName[] = ["chromium", "firefox", "webkit"];

const DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const;
const DEFAULT_TIMEOUT_MS = 10_000;
const LONG_PRESS_DEFAULT_MS = 800;

export interface BrowserDialogRecord {
  type: string;
  message: string;
  accepted: boolean;
}

export interface BrowserAdapterOptions {
  /** chromium | firefox | webkit (default chromium; overridden by target.browser). */
  browserName?: BrowserName;
  /** Headless by default; env CUMCP_BROWSER_HEADLESS=0 forces headed. */
  headless?: boolean;
  /** Connect to a running Chrome via CDP instead of launching (chromium only). */
  cdpEndpoint?: string;
  viewport?: { width: number; height: number };
  /** devicePixelRatio of the virtual screen; default 1 (screenshot px == CSS px). */
  deviceScaleFactor?: number;
  /** Home URL used by the `home` action; defaults to target.url, then about:blank. */
  baseUrl?: string;
  /** Extra launch args. */
  args?: string[];
  /** Unified target carried by the router factory closure. */
  target?: Target;
}

/** Dynamic import of the optional playwright dependency. Honest failure. */
async function loadPlaywright(): Promise<PlaywrightModule> {
  try {
    return await import("playwright");
  } catch (e) {
    throw unsupported(
      "browser platform",
      `playwright not installed — pnpm add playwright (${(e as Error).message})`,
    );
  }
}

/** Availability probe for the platform router (must not throw). */
export async function browserProbe(): Promise<{
  available: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}> {
  try {
    await loadPlaywright();
    return {
      available: true,
      details: { driver: "playwright", browsers: [...BROWSERS] },
    };
  } catch (e) {
    return { available: false, reason: (e as Error).message };
  }
}

/** Escape a value for embedding inside a `role=…[name="…"]` selector key. */
function escapeSelectorValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Normalize unified key names to playwright key names. */
const KEY_ALIASES: Record<string, string> = {
  cmd: "Meta",
  command: "Meta",
  win: "Meta",
  super: "Meta",
  meta: "Meta",
  ctrl: "Control",
  control: "Control",
  option: "Alt",
  alt: "Alt",
  return: "Enter",
  esc: "Escape",
  del: "Delete",
  spacebar: " ",
  space: " ",
};

export function normalizeKey(key: string): string {
  const lower = key.trim().toLowerCase();
  return KEY_ALIASES[lower] ?? key.trim();
}

interface ParsedAriaHeader {
  role: string;
  name?: string;
  flags: Record<string, string | true>;
}

/**
 * Parse one aria-snapshot line header, e.g.:
 *   button "登录" | heading "标题" [level=1] | checkbox [checked] | progressbar
 */
function parseAriaHeader(raw: string): ParsedAriaHeader | null {
  let s = raw.trim();
  if (!s || s.startsWith("/")) return null; // attribute entry like "/url"
  const flags: Record<string, string | true> = {};
  const flagRe = /\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = flagRe.exec(s)) !== null) {
    const f = m[1] as string;
    const eq = f.indexOf("=");
    if (eq === -1) flags[f.trim()] = true;
    else flags[f.slice(0, eq).trim()] = f.slice(eq + 1).trim();
  }
  s = s.replace(/\s*\[[^\]]*\]/g, "").trim();
  const firstSpace = s.indexOf(" ");
  let role: string;
  let name: string | undefined;
  if (firstSpace === -1) {
    role = s;
  } else {
    role = s.slice(0, firstSpace);
    const rest = s.slice(firstSpace + 1).trim();
    if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')) name = rest.slice(1, -1);
    else name = rest;
  }
  if (!role) return null;
  return { role, name, flags };
}

interface AriaListResult {
  nodes: UINode[];
  attrs: Record<string, string>;
}

/**
 * Convert the parsed ariaSnapshot YAML list into UINode[].
 * Shapes seen in the wild (playwright 1.49+):
 *   "button \"登录\""                      → leaf
 *   { "textbox \"用户名\"": "已填" }        → node with value
 *   { "link \"首页\"": [ { "/url": "#…" } ] } → node with children + attrs
 *   "progressbar"                          → bare role
 *   { "text": "some text" }                → plain text node
 */
function ariaListToNodes(items: unknown[], counter: { n: number }): AriaListResult {
  const nodes: UINode[] = [];
  const attrs: Record<string, string> = {};
  for (const item of items) {
    if (typeof item === "string") {
      const header = parseAriaHeader(item);
      if (header) nodes.push(makeAriaNode(header, undefined, undefined, counter));
    } else if (item && typeof item === "object") {
      const entries = Object.entries(item as Record<string, unknown>);
      for (const [key, value] of entries) {
        if (key.startsWith("/")) {
          attrs[key] = String(value);
          continue;
        }
        const header = parseAriaHeader(key);
        if (!header) continue;
        let children: AriaListResult | undefined;
        let valueStr: string | undefined;
        if (typeof value === "string") valueStr = value;
        else if (Array.isArray(value)) children = ariaListToNodes(value, counter);
        else if (value && typeof value === "object") {
          // rare: single object child — recurse into its entries
          children = ariaListToNodes([value], counter);
        }
        const node = makeAriaNode(header, valueStr, children, counter);
        nodes.push(node);
      }
    }
  }
  return { nodes, attrs };
}

function makeAriaNode(
  header: ParsedAriaHeader,
  value: string | undefined,
  children: AriaListResult | undefined,
  counter: { n: number },
): UINode {
  counter.n += 1;
  const node: UINode = {
    id: `ax:${counter.n}:${header.role}`,
    source: "dom",
    role: header.role,
    name: header.name,
    attributes: {},
  };
  if (value !== undefined && value !== "") node.value = value;
  const attrs: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(header.flags)) {
    if (k === "checked") {
      if (v === true) node.checked = true;
      else attrs.checked = String(v); // "mixed" and friends stay descriptive
    } else if (k === "selected") {
      if (v === true) node.selected = true;
      else attrs.selected = String(v);
    } else if (k === "disabled") {
      node.enabled = false;
    } else if (k === "level") {
      attrs.level = Number(v) || String(v);
    } else if (k === "pressed") {
      attrs.pressed = v === true ? true : String(v);
    } else if (k === "expanded") {
      attrs.expanded = v === true ? true : String(v) === "false" ? false : String(v);
    } else {
      attrs[k] = v === true ? true : String(v);
    }
  }
  if (children) {
    node.children = children.nodes;
    for (const [k, v] of Object.entries(children.attrs)) attrs[k] = v;
  }
  if (Object.keys(attrs).length > 0) node.attributes = attrs;
  else delete node.attributes;
  return node;
}

function pruneDepth(node: UINode, maxDepth: number): UINode {
  if (maxDepth <= 0 || !node.children) return node;
  if (maxDepth === 1) {
    const { children: _children, ...rest } = node;
    return rest;
  }
  return { ...node, children: node.children.map((c) => pruneDepth(c, maxDepth - 1)) };
}

/** Minimal structural view of a DOM element inside page.evaluate callbacks. */
interface DomEl {
  tagName: string;
  id: string;
  nodeType: number;
  type?: string;
  value?: string | number | null;
  checked?: boolean;
  disabled?: boolean;
  textContent?: string | null;
  getAttribute(name: string): string | null;
  selectedOptions?: ArrayLike<{ textContent: string | null }>;
  parentElement: DomEl | null;
  children: ArrayLike<DomEl>;
}

/** Everything buildElementRef needs, gathered in ONE page.evaluate round trip. */
interface DomProbe {
  role: string | null;
  name: string;
  value?: string;
  checked?: boolean;
  enabled: boolean;
  focused: boolean;
  css: string;
}

function probeDomElement(el: DomEl): DomProbe {
  const attr = (n: string) => el.getAttribute(n);
  // --- role (explicit, then implicit) ---
  let role: string | null = attr("role");
  if (!role) {
    const tag = el.tagName.toLowerCase();
    const type = (attr("type") || "").toLowerCase();
    if (tag === "input") {
      if (type === "checkbox") role = "checkbox";
      else if (type === "radio") role = "radio";
      else if (["submit", "button", "reset", "file", "image"].includes(type)) role = "button";
      else if (["range", "color"].includes(type)) role = "slider";
      else role = "textbox";
    } else if (tag === "select" || tag === "textarea") role = tag === "select" ? "combobox" : "textbox";
    else if (tag === "a") role = "link";
    else if (tag === "button") role = "button";
    else if (tag === "img") role = "img";
    else if (/^h[1-6]$/.test(tag)) role = "heading";
    else if (tag === "option") role = "option";
    else if (tag === "label") role = "label";
    else if (tag === "nav") role = "navigation";
    else if (tag === "main") role = "main";
    else if (tag === "header") role = "banner";
    else if (tag === "footer") role = "contentinfo";
    else if (tag === "form") role = "form";
    else if (tag === "ul" || tag === "ol") role = "list";
    else if (tag === "li") role = "listitem";
    else if (tag === "summary") role = "summary";
    else if (tag === "details") role = "group";
    else if (tag === "progress") role = "progressbar";
    else if (tag === "table") role = "table";
    else if (tag === "tr") role = "row";
    else if (tag === "td" || tag === "th") role = "cell";
    else if (tag === "p") role = "paragraph";
    else role = "generic";
  }
  // --- accessible name ---
  const inputish = ["input", "select", "textarea"].includes(el.tagName.toLowerCase());
  const named = attr("aria-label") || attr("placeholder") || attr("title") ||
    (inputish ? attr("value") || "" : el.textContent || "");
  const name = String(named).trim().replace(/\s+/g, " ").slice(0, 160);
  // --- value (form elements, else visible text for status/result regions) ---
  let value: string | undefined;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea") {
    if (el.type !== "checkbox" && el.type !== "radio") value = String(el.value ?? "");
  } else if (tag === "select") {
    const opt = el.selectedOptions && (el.selectedOptions as ArrayLike<{ textContent: string | null }>)[0];
    value = opt ? (opt.textContent || "").trim() : String(el.value ?? "");
  } else {
    const now = attr("aria-valuenow") ?? attr("aria-valuetext");
    if (now !== null && now !== undefined) value = String(now);
    else {
      const text = (el.textContent || "").trim().replace(/\s+/g, " ");
      if (text) value = text.slice(0, 160);
    }
  }
  // --- checked ---
  const checked =
    tag === "input" && (el.type === "checkbox" || el.type === "radio")
      ? !!el.checked
      : attr("aria-checked") === "true"
        ? true
        : undefined;
  // --- minimal unique CSS path (id-anchored) ---
  const seg = (e: DomEl): string => {
    if (e.id) return `#${e.id}`;
    let s = e.tagName.toLowerCase();
    const parent = e.parentElement;
    if (parent) {
      const same: DomEl[] = [];
      for (const c of Array.from(e.parentElement!.children)) if (c.tagName === e.tagName) same.push(c);
      if (same.length > 1) s += `:nth-of-type(${same.indexOf(e) + 1})`;
    }
    return s;
  };
  const parts: string[] = [];
  let cur: DomEl | null = el;
  while (cur && cur.nodeType === 1) {
    parts.unshift(seg(cur));
    if (cur.id) break;
    cur = cur.parentElement;
  }
  return {
    role,
    name,
    value,
    checked,
    enabled: !el.disabled,
    // Runs inside the page: document comes from the browser global scope.
    focused:
      (globalThis as { document?: { activeElement?: unknown } }).document?.activeElement === el,
    css: parts.join(" > "),
  };
}

export class BrowserAdapter implements PlatformAdapter {
  readonly platform = "browser";

  readonly browserName: BrowserName;
  readonly dialogs: BrowserDialogRecord[] = [];

  private readonly opts: BrowserAdapterOptions;
  private readonly target: Target;
  private info: TargetInfo | null = null;
  private caps: Capabilities;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private activePage: Page | null = null;
  private dsf = 1;
  private viewport: { width: number; height: number } = { ...DEFAULT_VIEWPORT };
  private closed = false;

  constructor(options: BrowserAdapterOptions = {}) {
    this.opts = options;
    this.target = options.target ?? { type: "browser", platform: "browser" };
    const requested = this.opts.browserName ?? (this.target.browser as BrowserName | undefined);
    if (requested !== undefined && !BROWSERS.includes(requested)) {
      throw new ComputerUseError(
        "invalid_request",
        `browser: unknown browser "${requested}" (supported: ${BROWSERS.join(", ")})`,
      );
    }
    this.browserName = requested ?? "chromium";
    this.caps = {
      screenshot: true,
      accessibility: true,
      dom: true,
      globalInput: true,
      windowControl: true,
      appControl: false,
      clipboard: false,
      multiDisplay: false,
      notes: [
        "clipboard: browser clipboard needs permissions — use type/set_value to move text",
        "appControl: not applicable — use focus(windowTitle) to switch tabs and target.url to navigate",
        "multiDisplay: a browser session renders a single viewport",
        "headless by default — set CUMCP_BROWSER_HEADLESS=0 for a headed browser",
      ],
    };
  }

  // ---------------------------------------------------------------- lifecycle

  async open(): Promise<TargetInfo> {
    if (this.info && !this.closed) return this.info;
    const pw = await loadPlaywright();

    const testIdAttr = process.env.CUMCP_TEST_ID_ATTR || "data-testid";
    try {
      pw.selectors.setTestIdAttribute(testIdAttr);
    } catch {
      // older playwright without the API — data-testid remains the default
    }

    const cdp = this.opts.cdpEndpoint ?? this.target.cdpEndpoint;
    if (cdp) {
      if (this.browserName !== "chromium") {
        throw unsupported("cdpEndpoint", "connecting over CDP requires chromium");
      }
      this.browser = await pw.chromium.connectOverCDP(cdp);
      this.context = this.browser.contexts()[0] ?? (await this.browser.newContext());
      this.dsf = 1; // unknown for remote contexts; honest default
      const pages = this.context.pages();
      this.activePage = pages[0] ?? (await this.context.newPage());
    } else {
      const headless = this.opts.headless ?? process.env.CUMCP_BROWSER_HEADLESS !== "0";
      const type =
        this.browserName === "firefox" ? pw.firefox : this.browserName === "webkit" ? pw.webkit : pw.chromium;
      this.browser = await type.launch({ headless, args: this.opts.args });
      if (this.opts.viewport) this.viewport = { ...this.opts.viewport };
      this.dsf = this.opts.deviceScaleFactor ?? 1;
      this.context = await this.browser.newContext({
        viewport: { ...this.viewport },
        deviceScaleFactor: this.dsf,
      });
      this.activePage = await this.context.newPage();
    }

    // Auto-accept JS dialogs on every page (present and future) so
    // automation never stalls; record them for evidence.
    const attach = (page: Page) => {
      page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
      page.on("dialog", (dialog: Dialog) => {
        this.dialogs.push({ type: dialog.type(), message: dialog.message(), accepted: true });
        void dialog.accept().catch(() => {});
      });
    };
    attach(this.activePage);
    this.context.on("page", (page: Page) => attach(page));

    const url = this.target.url;
    if (url) await this.activePage.goto(url).catch(() => {});

    this.closed = false;
    this.info = {
      id: `browser:${this.browserName}${cdp ? ":cdp" : ""}`,
      platform: "browser",
      type: "browser",
      name: `Browser (${this.browserName}${cdp ? ", CDP" : ", launched"})`,
      details: this.detailsSnapshot(cdp !== undefined),
    };
    return this.info;
  }

  async close(): Promise<void> {
    this.closed = true;
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    this.activePage = null;
    if (browser) {
      // For connectOverCDP this disconnects without killing the user's Chrome.
      await browser.close().catch(() => {});
    }
  }

  getTargetInfo(): TargetInfo {
    if (!this.info) {
      return {
        id: `browser:${this.browserName}`,
        platform: "browser",
        type: "browser",
        name: `Browser (${this.browserName})`,
      };
    }
    return { ...this.info, details: this.detailsSnapshot(this.info.id.endsWith(":cdp")) };
  }

  getCapabilities(): Capabilities {
    return this.caps;
  }

  private detailsSnapshot(cdp: boolean): Record<string, unknown> {
    const pages = this.listPages();
    return {
      browser: this.browserName,
      headless: cdp ? undefined : this.opts.headless ?? process.env.CUMCP_BROWSER_HEADLESS !== "0",
      cdp,
      url: this.activePage?.url() ?? null,
      activePage: Math.max(0, pages.indexOf(this.activePage as Page)),
      pageCount: pages.length,
      testIdAttribute: process.env.CUMCP_TEST_ID_ATTR || "data-testid",
    };
  }

  // ------------------------------------------------------------------ observe

  private listPages(): Page[] {
    return this.context?.pages() ?? [];
  }

  private requireActivePage(): Page {
    if (!this.activePage) {
      throw new ComputerUseError(
        "target_not_found",
        "browser: session is not open (call open() first)",
      );
    }
    return this.activePage;
  }

  private async viewportSize(page: Page): Promise<{ width: number; height: number }> {
    const vp = page.viewportSize();
    if (vp) return vp;
    try {
      const inner = (await page.evaluate(
        `() => ({ width: window.innerWidth, height: window.innerHeight })`,
      )) as { width: number; height: number };
      return inner;
    } catch {
      return { ...this.viewport };
    }
  }

  async observe(options: ObserveOptions = {}): Promise<Observation> {
    const page = this.requireActivePage();
    const vp = await this.viewportSize(page);
    const screen: ScreenInfo = {
      displays: [
        {
          id: "browser-viewport",
          x: 0,
          y: 0,
          width: vp.width,
          height: vp.height,
          scale: this.dsf,
          primary: true,
        },
      ],
      orientation: vp.width >= vp.height ? "landscape" : "portrait",
      width: vp.width,
      height: vp.height,
    };

    const screenshot = options.includeScreenshot === false ? undefined : await this.screenshot();

    let uiTree: UINode | undefined;
    let dom: unknown;
    if (options.includeUITree !== false || options.includeDom !== false) {
      const snapshot = await this.ariaSnapshot(page);
      if (snapshot !== undefined) {
        if (options.includeDom !== false) dom = snapshot;
        if (options.includeUITree !== false) {
          const parsed = parseYaml(snapshot) as unknown;
          const items = Array.isArray(parsed) ? parsed : [parsed];
          const counter = { n: 0 };
          const { nodes } = ariaListToNodes(items, counter);
          let root: UINode = {
            id: "ax:0:root",
            source: "dom",
            role: "document",
            name: await page.title().catch(() => undefined),
            children: nodes,
          };
          if (options.maxTreeDepth !== undefined) root = pruneDepth(root, options.maxTreeDepth);
          uiTree = root;
        }
      }
    }

    return {
      target: this.getTargetInfo(),
      screen,
      screenshot,
      activeApp: {
        name: `browser-${this.browserName}`,
        identifier: "playwright",
        context: page.url(),
        frontmost: true,
      },
      uiTree,
      dom,
      windows: await this.listWindows(),
      capabilities: this.caps,
      capturedAt: Date.now(),
    };
  }

  /** ariaSnapshot string of the active page, undefined when unavailable. */
  private async ariaSnapshot(page: Page): Promise<string | undefined> {
    try {
      return await page.locator("body").ariaSnapshot();
    } catch {
      try {
        return await (page as unknown as { ariaSnapshot?: () => Promise<string> }).ariaSnapshot?.();
      } catch {
        return undefined;
      }
    }
  }

  // --------------------------------------------------------------- screenshot

  async screenshot(options: ScreenshotOptions = {}): Promise<Screenshot> {
    const page = this.requireActivePage();

    // windowId doubles as a page selector ("page:<index>" from listWindows).
    if (options.windowId !== undefined) {
      const m = /^page:(\d+)$/.exec(options.windowId);
      if (m) {
        const pages = this.listPages();
        const idx = Number(m[1]);
        const target = pages[idx];
        if (!target) {
          throw new ComputerUseError("target_not_found", `browser: no page "${options.windowId}"`);
        }
        this.activePage = target;
      }
    }
    const active = this.requireActivePage();
    const vp = await this.viewportSize(active);

    const clip =
      options.region && options.region.width > 0 && options.region.height > 0
        ? {
            x: options.region.x,
            y: options.region.y,
            width: Math.min(options.region.width, vp.width - options.region.x),
            height: Math.min(options.region.height, vp.height - options.region.y),
          }
        : undefined;

    const raw: Buffer = await active.screenshot({ type: "png", ...(clip ? { clip } : {}) });
    return processScreenshot(
      raw,
      {
        targetId: this.getTargetInfo().id,
        scale: this.dsf,
        origin: clip ? { x: clip.x, y: clip.y } : { x: 0, y: 0 },
        orientation: vp.width >= vp.height ? "landscape" : "portrait",
      },
      { format: "png" },
    );
  }

  // ------------------------------------------------------------------ locate

  async locate(descriptor: {
    role?: string;
    name?: string;
    text?: string;
    resourceId?: string;
    css?: string;
    xpath?: string;
    testId?: string;
    index?: number;
  }): Promise<{ element: ElementRef } | null> {
    const page = this.requireActivePage();

    let locator: Locator | null = null;
    let selectorKey = "";

    // Exact priority: role+name → text → testId/resourceId → css → xpath.
    if (descriptor.role && descriptor.name !== undefined) {
      locator = page.getByRole(descriptor.role as PlaywrightAriaRole, { name: descriptor.name });
      selectorKey = `role=${descriptor.role}[name="${escapeSelectorValue(descriptor.name)}"]`;
    } else if (descriptor.text !== undefined && descriptor.text !== "") {
      locator = page.getByText(descriptor.text);
      selectorKey = `text="${escapeSelectorValue(descriptor.text)}"`;
    } else if (descriptor.testId !== undefined || descriptor.resourceId !== undefined) {
      const tid = descriptor.testId ?? descriptor.resourceId ?? "";
      locator = page.getByTestId(tid);
      selectorKey = `testid=${tid}`;
    } else if (descriptor.css) {
      locator = page.locator(descriptor.css);
      selectorKey = `css=${descriptor.css}`;
    } else if (descriptor.xpath) {
      locator = page.locator(`xpath=${descriptor.xpath}`);
      selectorKey = `xpath=${descriptor.xpath}`;
    } else {
      throw new ComputerUseError(
        "invalid_request",
        "browser.locate: provide role+name, text, testId, css or xpath",
      );
    }

    if (typeof descriptor.index === "number") {
      locator = locator.nth(descriptor.index);
      selectorKey += ` >> nth=${descriptor.index}`;
    } else {
      locator = locator.first();
    }

    if ((await locator.count()) === 0) return null;
    return { element: await this.buildElementRef(locator, selectorKey) };
  }

  /** Resolve an ElementRef (whose id is a playwright selector key) back to a Locator. */
  private async resolveLocator(el?: ElementRef): Promise<Locator> {
    const page = this.requireActivePage();
    if (el && typeof el.id === "string" && el.id.length > 0) {
      if (el.id.startsWith("ax:")) {
        // Node from the aria tree — re-resolve via role + accessible name.
        if (el.role && el.name) {
          const exact = page.getByRole(el.role as PlaywrightAriaRole, { name: el.name, exact: true });
          if ((await exact.count()) > 0) return exact.first();
          const fuzzy = page.getByRole(el.role as PlaywrightAriaRole, { name: el.name });
          if ((await fuzzy.count()) > 0) return fuzzy.first();
        }
        throw new ComputerUseError(
          "element_not_found",
          `browser: aria tree node "${el.id}" no longer matches the page`,
        );
      }
      const loc = page.locator(el.id);
      if ((await loc.count()) > 0) return loc.first();
      throw new ComputerUseError("element_not_found", `browser: element "${el.id}" not found on page`);
    }
    if (el?.role && el.name) {
      const loc = page.getByRole(el.role as PlaywrightAriaRole, { name: el.name });
      if ((await loc.count()) > 0) return loc.first();
    }
    throw new ComputerUseError(
      "invalid_request",
      "browser: element reference carries no resolvable selector id",
    );
  }

  private async buildElementRef(locator: Locator, selectorKey: string): Promise<ElementRef> {
    // One serialized-callback round trip. IMPORTANT: playwright evaluates
    // *string* page functions as bare expressions (the element is never
    // passed), so this must stay a real function.
    const probe = await locator.evaluate(probeDomElement).catch(() => null);

    const [enabled, box] = await Promise.all([
      probe?.enabled === false ? Promise.resolve(false) : locator.isEnabled().catch(() => true),
      locator.boundingBox().catch(() => null),
    ]);

    const role = probe?.role ?? undefined;
    const element: ElementRef = {
      id: selectorKey,
      source: "dom",
      role,
      name: probe?.name || undefined,
      value: probe?.value,
      bounds: box
        ? {
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
          }
        : undefined,
      enabled,
      checked: probe?.checked,
      focused: probe?.focused ?? false,
      clickable: ["button", "link", "checkbox", "radio", "menuitem", "tab", "option"].includes(
        role ?? "",
      ),
      editable: ["textbox", "searchbox", "combobox", "spinbutton"].includes(role ?? ""),
      attributes: {
        css: probe?.css || selectorKey,
        selector: selectorKey,
      },
    };
    return element;
  }

  // ------------------------------------------------------------------ actions

  async executeAction(action: Action): Promise<ActionResult> {
    const started = Date.now();
    try {
      const out = await this.executeInner(action);
      return { ...out, durationMs: Date.now() - started };
    } catch (e) {
      const err =
        e instanceof ComputerUseError
          ? e
          : new ComputerUseError(
              (e as Error)?.name === "TimeoutError" ? "timeout" : "internal_error",
              `browser: ${(e as Error).message}`,
            );
      return {
        ok: false,
        method: "system",
        error: { code: err.code, message: err.message, hint: err.hint },
        durationMs: Date.now() - started,
      };
    }
  }

  /** Map a unified PointInSpace to viewport CSS pixels. */
  private toCssPoint(p: { x: number; y: number; space?: string }, vp: { width: number; height: number }): Point {
    const space = p.space ?? "screenshot";
    switch (space) {
      case "normalized":
        return { x: (p.x / 1000) * vp.width, y: (p.y / 1000) * vp.height };
      case "screenshot":
      case "physical":
        return { x: p.x / this.dsf, y: p.y / this.dsf };
      default:
        return { x: p.x, y: p.y }; // logical == CSS px in a browser
    }
  }

  private toScreenshotPoint(css: Point): Point {
    return { x: css.x * this.dsf, y: css.y * this.dsf };
  }

  /** Center of an element's bounding box, in CSS px. */
  private async centerOf(locator: Locator): Promise<Point> {
    const box = await locator.boundingBox();
    if (!box) throw new ComputerUseError("element_not_found", "browser: element has no bounding box");
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  private async executeInner(action: Action): Promise<Omit<ActionResult, "durationMs">> {
    const page = this.requireActivePage();
    const vp = await this.viewportSize(page);

    switch (action.type) {
      case "click": {
        if (action.element) {
          const loc = await this.resolveLocator(action.element);
          await loc.click({ button: action.button === "right" ? "right" : "left" });
          return { ok: true, method: "semantic", element: action.element };
        }
        if (action.point) {
          const css = this.toCssPoint(action.point, vp);
          await page.mouse.click(css.x, css.y, { button: action.button === "right" ? "right" : "left" });
          return { ok: true, method: "coordinate", point: this.toScreenshotPoint(css) };
        }
        throw new ComputerUseError("invalid_request", "browser: click requires element or point");
      }
      case "invoke": {
        // DOM semantics: invoke == activate the element (left click).
        const loc = await this.resolveLocator(action.element);
        await loc.click();
        return { ok: true, method: "semantic", element: action.element };
      }
      case "right_click": {
        if (action.element) {
          const loc = await this.resolveLocator(action.element);
          await loc.click({ button: "right" });
          return { ok: true, method: "semantic", element: action.element };
        }
        if (action.point) {
          const css = this.toCssPoint(action.point, vp);
          await page.mouse.click(css.x, css.y, { button: "right" });
          return { ok: true, method: "coordinate", point: this.toScreenshotPoint(css) };
        }
        throw new ComputerUseError("invalid_request", "browser: right_click requires element or point");
      }
      case "double_click": {
        if (action.element) {
          const loc = await this.resolveLocator(action.element);
          await loc.dblclick();
          return { ok: true, method: "semantic", element: action.element };
        }
        if (action.point) {
          const css = this.toCssPoint(action.point, vp);
          await page.mouse.dblclick(css.x, css.y);
          return { ok: true, method: "coordinate", point: this.toScreenshotPoint(css) };
        }
        throw new ComputerUseError("invalid_request", "browser: double_click requires element or point");
      }
      case "long_press": {
        const duration = action.durationMs ?? LONG_PRESS_DEFAULT_MS;
        if (action.element) {
          const loc = await this.resolveLocator(action.element);
          await loc.click({ delay: duration }); // mousedown → hold → mouseup
          return { ok: true, method: "semantic", element: action.element };
        }
        if (action.point) {
          const css = this.toCssPoint(action.point, vp);
          await page.mouse.move(css.x, css.y);
          await page.mouse.down();
          await page.waitForTimeout(duration);
          await page.mouse.up();
          return { ok: true, method: "coordinate", point: this.toScreenshotPoint(css) };
        }
        throw new ComputerUseError("invalid_request", "browser: long_press requires element or point");
      }
      case "move": {
        const css = this.toCssPoint(action.point, vp);
        await page.mouse.move(css.x, css.y);
        return { ok: true, method: "coordinate", point: this.toScreenshotPoint(css) };
      }
      case "drag":
      case "swipe": {
        const from = action.from;
        const to = action.to;
        if (from?.element && to?.element) {
          const fromLoc = await this.resolveLocator(from.element);
          const toLoc = await this.resolveLocator(to.element);
          await fromLoc.dragTo(toLoc);
          return { ok: true, method: "semantic" };
        }
        const fromCss = from?.element
          ? await this.centerOf(await this.resolveLocator(from.element))
          : from?.point
            ? this.toCssPoint(from.point, vp)
            : undefined;
        const toCss = to?.element
          ? await this.centerOf(await this.resolveLocator(to.element))
          : to?.point
            ? this.toCssPoint(to.point, vp)
            : undefined;
        if (!fromCss || !toCss) {
          throw new ComputerUseError("invalid_request", `browser: ${action.type} requires from and to`);
        }
        const steps = action.durationMs
          ? Math.max(2, Math.min(50, Math.round(action.durationMs / 20)))
          : 12;
        await page.mouse.move(fromCss.x, fromCss.y);
        await page.mouse.down();
        await page.mouse.move(toCss.x, toCss.y, { steps });
        await page.mouse.up();
        return {
          ok: true,
          method: "coordinate",
          point: this.toScreenshotPoint(toCss),
        };
      }
      case "scroll": {
        const amount = action.amount ?? 300;
        if (action.element) {
          const loc = await this.resolveLocator(action.element);
          await loc.scrollIntoViewIfNeeded();
          return { ok: true, method: "semantic", element: action.element };
        }
        if (action.point) {
          const css = this.toCssPoint(action.point, vp);
          await page.mouse.move(css.x, css.y);
        }
        const dx = action.direction === "right" ? amount : action.direction === "left" ? -amount : 0;
        const dy = action.direction === "down" ? amount : action.direction === "up" ? -amount : 0;
        await page.mouse.wheel(dx, dy);
        await page.waitForTimeout(150); // let scroll events settle
        return {
          ok: true,
          method: "coordinate",
          point: action.point ? this.toScreenshotPoint(this.toCssPoint(action.point, vp)) : undefined,
        };
      }
      case "type": {
        if (action.element) {
          const loc = await this.resolveLocator(action.element);
          const focused = await loc
            .evaluate(
              (el: DomEl) =>
                (globalThis as { document?: { activeElement?: unknown } }).document?.activeElement ===
                el,
            )
            .catch(() => false);
          if (!focused) await loc.focus();
          // pressSequentially appends at the caret (never clears existing text);
          // use set_value/fill when replacement is wanted.
          await loc.pressSequentially(action.text);
          if (action.submit) await loc.press("Enter");
          return { ok: true, method: "semantic", element: action.element };
        }
        await page.keyboard.type(action.text);
        if (action.submit) await page.keyboard.press("Enter");
        return { ok: true, method: "semantic" };
      }
      case "set_value": {
        const loc = await this.resolveLocator(action.element);
        await loc.fill(action.value);
        return { ok: true, method: "semantic", element: action.element };
      }
      case "clear": {
        const loc = await this.resolveLocator(action.element);
        await loc.fill("");
        return { ok: true, method: "semantic", element: action.element };
      }
      case "press": {
        const key = normalizeKey(action.key);
        if (action.element) {
          const loc = await this.resolveLocator(action.element);
          await loc.press(key);
          return { ok: true, method: "semantic", element: action.element };
        }
        await page.keyboard.press(key);
        return { ok: true, method: "system" };
      }
      case "hotkey": {
        const combo = action.keys.map(normalizeKey).join("+");
        await page.keyboard.press(combo);
        return { ok: true, method: "system", detail: combo };
      }
      case "select": {
        const loc = await this.resolveLocator(action.element);
        if (typeof action.index === "number") {
          await loc.selectOption({ index: action.index });
        } else if (action.value !== undefined) {
          try {
            await loc.selectOption({ label: action.value }, { timeout: 2000 });
          } catch {
            await loc.selectOption({ value: action.value });
          }
        } else {
          throw new ComputerUseError("invalid_request", "browser: select requires value or index");
        }
        return { ok: true, method: "semantic", element: action.element };
      }
      case "toggle": {
        const loc = await this.resolveLocator(action.element);
        const current = await loc.isChecked().catch(() => false);
        await loc.setChecked(action.value ?? !current);
        return { ok: true, method: "semantic", element: action.element };
      }
      case "focus": {
        if (action.element) {
          const loc = await this.resolveLocator(action.element);
          await loc.focus();
          return { ok: true, method: "semantic", element: action.element };
        }
        await this.focusTarget({ app: action.app, windowTitle: action.windowTitle });
        return { ok: true, method: "system" };
      }
      case "back": {
        await page.goBack();
        return { ok: true, method: "system", detail: page.url() };
      }
      case "home": {
        const url = this.opts.baseUrl ?? this.target.url ?? "about:blank";
        await page.goto(url);
        return { ok: true, method: "system", detail: url };
      }
      case "wait": {
        await page.waitForTimeout(action.durationMs);
        return { ok: true, method: "system" };
      }
      case "launch_app":
        throw unsupported(
          "launch_app",
          "browsers have no apps — use target.url / goto to navigate, focus(windowTitle) to switch tabs",
        );
      case "terminate_app":
        throw unsupported("terminate_app", "browsers have no apps — close tabs/pages instead");
      case "finish":
        return { ok: true, method: "system", detail: `finish:${action.status}` };
      case "fail":
        return { ok: true, method: "system", detail: `fail:${action.reason}` };
      default: {
        const exhaustive: never = action;
        throw new ComputerUseError(
          "invalid_request",
          `browser: unhandled action ${(exhaustive as Action).type}`,
        );
      }
    }
  }

  // ------------------------------------------------------------------- system

  async listApps(): Promise<AppInfo[]> {
    const page = this.activePage;
    return [
      {
        name: `browser-${this.browserName}`,
        identifier: "playwright",
        context: page?.url(),
        frontmost: true,
      },
    ];
  }

  async listWindows(): Promise<WindowInfo[]> {
    const page = this.requireActivePage();
    const vp = await this.viewportSize(page);
    const pages = this.listPages();
    return Promise.all(
      pages.map(async (p, i) => ({
        id: `page:${i}`,
        title: await p.title().catch(() => p.url()),
        app: `browser-${this.browserName}`,
        bounds: { x: 0, y: 0, width: vp.width, height: vp.height },
        minimized: false,
        focused: p === this.activePage,
      })),
    );
  }

  async launchApp(_app: string, _options?: LaunchOptions): Promise<void> {
    throw unsupported(
      "launch_app",
      "browsers have no apps — use target.url / goto to navigate, focus(windowTitle) to switch tabs",
    );
  }

  async terminateApp(_app: string): Promise<void> {
    throw unsupported("terminate_app", "browsers have no apps — close tabs/pages instead");
  }

  /** Switch the active page by partial window title (then URL fallback). */
  async focusTarget(options: { app?: string; windowTitle?: string }): Promise<void> {
    const pages = this.listPages();
    if (pages.length === 0) {
      throw new ComputerUseError("target_not_found", "browser: no open pages");
    }
    const needle = (options.windowTitle ?? options.app ?? "").trim().toLowerCase();
    if (!needle) {
      this.activePage = pages[0] as Page;
      return;
    }
    for (const p of pages) {
      const title = (await p.title().catch(() => "")).toLowerCase();
      if (title.includes(needle)) {
        this.activePage = p;
        return;
      }
    }
    for (const p of pages) {
      if (p.url().toLowerCase().includes(needle)) {
        this.activePage = p;
        return;
      }
    }
    const titles: string[] = [];
    for (const p of pages) titles.push(await p.title().catch(() => p.url()));
    throw new ComputerUseError(
      "target_not_found",
      `browser: no page matching "${needle}"`,
      { hint: `Open pages: ${titles.join(" | ") || "(untitled)"}` },
    );
  }

  // ------------------------------------------------------- convenience extras
  // (Not part of PlatformAdapter — used by callers/tests to drive the session.)

  /** Navigate the active page. */
  async goto(url: string): Promise<void> {
    await this.requireActivePage().goto(url);
  }

  /** URL of the active page. */
  get url(): string {
    return this.requireActivePage().url();
  }

  /** Open a URL in a new tab and make it active. */
  async openInNewTab(url: string): Promise<Page> {
    const context = this.requireActivePage().context();
    const page = await context.newPage();
    this.activePage = page;
    if (url) await page.goto(url).catch(() => {});
    return page;
  }
}
