/**
 * REAL browser E2E for the Browser PlatformAdapter (spec §11/§12).
 *
 * Runs against a local file:// fixture (tests/fixtures/app.html) with
 * Playwright + Chromium — no network access required. Skipped honestly
 * when playwright is missing or RUN_BROWSER_E2E=0.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pathToFileURL } from "node:url";
import { BrowserAdapter, browserProbe } from "../../src/platforms/browser/adapter.js";
import { decodeImage } from "../../src/screenshot/pipeline.js";
import { ComputerUseError } from "../../src/core/errors.js";
import type { ElementRef, UINode } from "../../src/core/types.js";
import type { Action } from "../../src/core/types-action.js";

const RUN = process.env.RUN_BROWSER_E2E !== "0";
const FIXTURE_URL = pathToFileURL(new URL("../fixtures/app.html", import.meta.url).pathname).href;

/** All roles in a UI tree, depth-first. */
function collectRoles(node: UINode, out: Set<string> = new Set()): Set<string> {
  if (node.role) out.add(node.role);
  for (const child of node.children ?? []) collectRoles(child, out);
  return out;
}

function findNode(node: UINode, pred: (n: UINode) => boolean): UINode | undefined {
  if (pred(node)) return node;
  for (const child of node.children ?? []) {
    const hit = findNode(child, pred);
    if (hit) return hit;
  }
  return undefined;
}

describe.skipIf(!RUN)("BrowserAdapter E2E (playwright + chromium, file:// fixture)", () => {
  let adapter: BrowserAdapter;

  beforeAll(async () => {
    const probe = await browserProbe();
    if (!probe.available) throw new Error(`playwright unavailable: ${probe.reason}`);
    adapter = new BrowserAdapter({
      headless: true,
      browserName: "chromium",
      viewport: { width: 1024, height: 768 },
    });
    await adapter.open();
    await adapter.goto(FIXTURE_URL);
  }, 60_000);

  afterAll(async () => {
    await adapter?.close();
  });

  async function run<T extends Action>(action: T) {
    const result = await adapter.executeAction(action);
    expect(result.error, `action ${action.type} failed: ${result.error?.message}`).toBeUndefined();
    expect(result.ok).toBe(true);
    return result;
  }

  async function locateOrThrow(descriptor: Parameters<BrowserAdapter["locate"]>[0]): Promise<ElementRef> {
    const found = await adapter.locate(descriptor);
    expect(found, `locate(${JSON.stringify(descriptor)}) returned null`).not.toBeNull();
    return (found as { element: ElementRef }).element;
  }

  it("probe reports playwright availability", async () => {
    const probe = await browserProbe();
    expect(probe.available).toBe(true);
  });

  it("capabilities are honest (dom/screenshot/input yes, appControl/clipboard no)", () => {
    const caps = adapter.getCapabilities();
    expect(caps.screenshot).toBe(true);
    expect(caps.dom).toBe(true);
    expect(caps.accessibility).toBe(true);
    expect(caps.globalInput).toBe(true);
    expect(caps.windowControl).toBe(true);
    expect(caps.appControl).toBe(false);
    expect(caps.clipboard).toBe(false);
    expect(caps.multiDisplay).toBe(false);
    expect(caps.notes?.some((n) => n.includes("clipboard"))).toBe(true);
  });

  it("getTargetInfo exposes browser details incl. activePage", async () => {
    const info = adapter.getTargetInfo();
    expect(info.platform).toBe("browser");
    expect(info.type).toBe("browser");
    expect(info.details?.browser).toBe("chromium");
    expect(info.details?.headless).toBe(true);
    expect(info.details?.activePage).toBe(0);
    expect(String(info.details?.url)).toMatch(/^file:\/\/.*app\.html$/);
  });

  it("locate: role+name, testId, css, and honest null on miss", async () => {
    const byRole = await locateOrThrow({ role: "button", name: "登录" });
    expect(byRole.source).toBe("dom");
    expect(byRole.role).toBe("button");
    expect(byRole.name).toBe("登录");
    expect(byRole.bounds).toBeDefined();
    expect(byRole.bounds!.width).toBeGreaterThan(0);
    expect(byRole.attributes?.css).toBe("#login-btn"); // id-anchored minimal selector

    const byTestId = await locateOrThrow({ testId: "version-badge" });
    expect(byTestId.name).toBe("v1.0.0");

    const byCss = await locateOrThrow({ css: "#result" });
    expect(byCss).toBeDefined();
    expect(byCss.attributes?.selector).toBe("css=#result");

    const byText = await locateOrThrow({ text: "本地页面" });
    expect(byText.role).toBe("paragraph");

    const miss = await adapter.locate({ role: "button", name: "不存在的按钮" });
    expect(miss).toBeNull();
  });

  it("click via semantic element updates the result div (verified through locate value)", async () => {
    const button = await locateOrThrow({ role: "button", name: "登录" });
    const result = await run({ type: "click", element: button });
    expect(result.method).toBe("semantic");

    const resultDiv = await locateOrThrow({ css: "#result" });
    expect(resultDiv.value).toBe("已登录: 匿名 (主题: 浅色)");

    // Nav link click also feeds the result div.
    const settingsLink = await locateOrThrow({ role: "link", name: "设置" });
    await run({ type: "click", element: settingsLink });
    const again = await locateOrThrow({ css: "#result" });
    expect(again.value).toBe("导航: 设置");
  });

  it("set_value + type + submit performs the login flow", async () => {
    const username = await locateOrThrow({ css: "#username" });
    await run({ type: "set_value", element: username, value: "行者" });

    const password = await locateOrThrow({ role: "textbox", name: "密码" });
    await run({ type: "type", element: password, text: "secret123", submit: true });

    const resultDiv = await locateOrThrow({ testId: "result-panel" });
    expect(resultDiv.value).toContain("已登录: 行者");

    const userAfter = await locateOrThrow({ css: "#username" });
    expect(userAfter.value).toBe("行者");
  });

  it("toggle flips the checkbox and checked state is readable", async () => {
    const before = await locateOrThrow({ role: "checkbox", name: "自动更新" });
    expect(before.checked).toBe(true); // checked by default in the fixture

    await run({ type: "toggle", element: before, value: false });
    expect((await locateOrThrow({ role: "checkbox", name: "自动更新" })).checked).toBe(false);

    const after = await locateOrThrow({ role: "checkbox", name: "自动更新" });
    await run({ type: "toggle", element: after }); // no value → flip
    expect((await locateOrThrow({ role: "checkbox", name: "自动更新" })).checked).toBe(true);
  });

  it("select sets the combobox by label", async () => {
    const theme = await locateOrThrow({ role: "combobox", name: "主题" });
    await run({ type: "select", element: theme, value: "深色" });

    const after = await locateOrThrow({ role: "combobox", name: "主题" });
    expect(after.value).toBe("深色");

    // index-based selection also works
    await run({ type: "select", element: after, index: 2 });
    expect((await locateOrThrow({ role: "combobox", name: "主题" })).value).toBe("跟随系统");
  });

  it("scroll moves the page and the fixture reports the position", async () => {
    await run({ type: "scroll", direction: "down", amount: 600 });
    const pos = await locateOrThrow({ css: "#scroll-pos" });
    expect(pos.value).toBeDefined();
    expect(pos.value).not.toBe("滚动位置: 0");
    expect(Number((pos.value as string).replace(/\D/g, ""))).toBeGreaterThan(0);
  });

  it("hotkey select-all selects the text, so pressing a key replaces it", async () => {
    const username = await locateOrThrow({ css: "#username" });
    await run({ type: "set_value", element: username, value: "hello world" });
    await run({ type: "focus", element: username });
    // macOS text fields bind Control+a to "start of line"; select-all is Meta+a there.
    const selectAll = process.platform === "darwin" ? ["cmd", "a"] : ["ctrl", "a"];
    await run({ type: "hotkey", keys: selectAll });
    await run({ type: "press", key: "x", element: username });
    expect((await locateOrThrow({ css: "#username" })).value).toBe("x");
  });

  it("confirm() dialog is auto-accepted and recorded", async () => {
    const btn = await locateOrThrow({ role: "button", name: "打开确认对话框" });
    await run({ type: "click", element: btn });

    const resultDiv = await locateOrThrow({ css: "#result" });
    expect(resultDiv.value).toBe("已确认对话框");
    const confirm = [...adapter.dialogs].reverse().find((d) => d.type === "confirm");
    expect(confirm).toBeDefined();
    expect(confirm!.message).toContain("确认执行此操作");
  });

  it("screenshot is a valid PNG decodable by the shared pipeline", async () => {
    const shot = await adapter.screenshot();
    expect(shot.format).toBe("png");
    expect(shot.scale).toBe(1); // deviceScaleFactor defaults to 1 → CSS px space
    expect(shot.origin).toEqual({ x: 0, y: 0 });
    expect(shot.orientation).toBe("landscape");
    expect(shot.width).toBe(1024);
    expect(shot.height).toBe(768);
    expect(shot.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(shot.targetId).toContain("browser:chromium");

    const decoded = decodeImage(Buffer.from(shot.dataBase64, "base64"));
    expect(decoded.width).toBe(1024);
    expect(decoded.height).toBe(768);
    expect(decoded.data.length).toBe(1024 * 768 * 4);

    // ROI capture honors ScreenshotOptions.region.
    const roi = await adapter.screenshot({ region: { x: 10, y: 20, width: 120, height: 60 } });
    expect(roi.origin).toEqual({ x: 10, y: 20 });
    expect(roi.width).toBe(120);
    expect(roi.height).toBe(60);
  });

  it("observe builds a UINode tree and dom string from the aria snapshot", async () => {
    const obs = await adapter.observe({ includeScreenshot: false, includeDom: true });
    expect(obs.target.platform).toBe("browser");
    expect(obs.screen.width).toBe(1024);
    expect(obs.screen.height).toBe(768);
    expect(obs.screen.displays[0]!.scale).toBe(1);

    const tree = obs.uiTree!;
    const roles = collectRoles(tree);
    for (const role of ["navigation", "link", "heading", "textbox", "checkbox", "button", "combobox"]) {
      expect(roles.has(role), `uiTree missing role "${role}"`).toBe(true);
    }
    const checkbox = findNode(tree, (n) => n.role === "checkbox");
    expect(checkbox?.name).toBe("自动更新");
    expect(checkbox?.checked).toBe(true);

    // dom field carries the aria snapshot string
    expect(typeof obs.dom).toBe("string");
    expect(String(obs.dom)).toContain('checkbox "自动更新"');
  });

  it("launch_app / terminate_app are honestly unsupported", async () => {
    const result = await adapter.executeAction({ type: "launch_app", app: "Safari" });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("unsupported");

    const terminate = await adapter.executeAction({ type: "terminate_app", app: "Safari" });
    expect(terminate.ok).toBe(false);
    expect(terminate.error?.code).toBe("unsupported");

    await expect(adapter.launchApp("Safari")).rejects.toMatchObject({ code: "unsupported" });
  });

  it("locate on the aria tree node id resolves for actions (click nav via tree ref)", async () => {
    const obs = await adapter.observe({ includeScreenshot: false });
    const helpLink = findNode(obs.uiTree!, (n) => n.role === "link" && n.name === "帮助");
    expect(helpLink).toBeDefined();
    await run({ type: "click", element: helpLink as ElementRef });
    const resultDiv = await locateOrThrow({ css: "#result" });
    expect(resultDiv.value).toBe("导航: 帮助");
  });

  it("back goes back in history", async () => {
    await adapter.goto(FIXTURE_URL);
    const home = await locateOrThrow({ role: "link", name: "首页" });
    await run({ type: "click", element: home });
    expect(adapter.url).toContain("#home");
    await run({ type: "back" });
    expect(adapter.url).not.toContain("#home");
  });

  it("multi-tab: openInNewTab + focus(windowTitle) switches the active page", async () => {
    await adapter.openInNewTab(`${FIXTURE_URL}#second`);
    const info = adapter.getTargetInfo();
    expect(info.details?.pageCount).toBe(2);
    expect(info.details?.activePage).toBe(1);
    expect(adapter.url).toContain("#second");

    const wins = await adapter.listWindows();
    expect(wins).toHaveLength(2);
    expect(wins[1]!.focused).toBe(true);
    expect(wins[1]!.title).toBe("第二标签页 — 设置");

    // Switch back by partial title.
    await adapter.focusTarget({ windowTitle: "示例应用" });
    expect(adapter.url).not.toContain("#second");
    expect(adapter.getTargetInfo().details?.activePage).toBe(0);

    await expect(adapter.focusTarget({ windowTitle: "不存在的窗口" })).rejects.toBeInstanceOf(
      ComputerUseError,
    );
  });
});
