/**
 * Android adapter unit tests — fully hermetic (mocked adb exec + fixture XML).
 *
 * HONEST SCOPE NOTE: these tests prove PARSING and SEMANTICS (dump parsing,
 * device selection, action translation against mocked adb output). Real-device
 * E2E is out of scope on this host (no adb) and is NOT covered here.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import type { UINode } from "../../src/core/types.js";
import {
  AdbClient,
  adbCandidates,
  discoverAdbPath,
  parseDevices,
  quoteDeviceArg,
  type AdbExecFn,
  type AdbExecOptions,
  type AdbResult,
} from "../../src/platforms/android/adb.js";
import { centerOf, classToRole, findBy, parseBounds, parseDump, resolveNode } from "../../src/platforms/android/uiautomator.js";
import {
  AndroidAdapter,
  androidProbe,
  parseWmDensity,
  parseWmSize,
  type AndroidAdapterOptions,
} from "../../src/platforms/android/adapter.js";

const here = dirname(fileURLToPath(import.meta.url));
const dumpXml = readFileSync(join(here, "..", "fixtures", "uiautomator-dump.xml"), "utf8");

const SERIAL = "emulator-5554";
const SAVE_BUTTON_CENTER = { x: 912, y: 1048 }; // [816,1000][1008,1096]

const DEVICES_MULTI = [
  "List of devices attached",
  "emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1",
  "PIXEL7A                device product:panther model:Pixel_7a device:panther transport_id:2",
  "PIXEL6OFF              offline product:raven model:Pixel_6 transport_id:3",
  "PIXEL6AUTH             unauthorized product:raven model:Pixel_6 transport_id:4",
  "",
].join("\n");

const DUMPSYS_ACTIVITY = [
  "ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)",
  "  mResumedActivity: ActivityRecord{5cd4d4c u0 com.android.settings/.Settings t123}",
  "",
].join("\n");

interface RecordedCall {
  args: string[];
  opts?: AdbExecOptions;
}

function makePng(w: number, h: number): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    png.data[i * 4] = 10;
    png.data[i * 4 + 1] = 20;
    png.data[i * 4 + 2] = 30;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

interface ExecOverrides {
  devices?: string;
  dump?: string;
  ime?: string;
  rotation?: string;
  power?: string;
  screencapPng?: Buffer;
}

function makeExec(overrides: ExecOverrides = {}): { exec: AdbExecFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const out = (s: string): AdbResult => ({ code: 0, stdout: s, stdoutBuffer: Buffer.from(s, "utf8"), stderr: "" });
  const png = overrides.screencapPng ?? makePng(320, 640);
  const exec: AdbExecFn = async (_file, args, opts) => {
    calls.push({ args, opts });
    const s = args.join(" ");
    if (s === "devices -l") return out(overrides.devices ?? DEVICES_MULTI);
    if (s.includes("uiautomator dump")) return out("UI hierchary dumped to: /sdcard/window_dump.xml\n");
    if (s.includes("cat /sdcard/window_dump.xml")) return out(overrides.dump ?? dumpXml);
    if (s.includes("wm size")) return out("Physical size: 1080x2340\n");
    if (s.includes("wm density")) return out("Physical density: 440\n");
    if (s.includes("ime list -s")) return out(overrides.ime ?? "");
    if (s.includes("settings get system user_rotation")) return out(`${overrides.rotation ?? "0"}\n`);
    if (s.includes("dumpsys power")) return out(overrides.power ?? "mWakefulness=Awake\nmHoldingDisplaySuspendBlocker=true\n");
    if (s.includes("screencap")) return { code: 0, stdout: "", stdoutBuffer: png, stderr: "" };
    if (s.includes("dumpsys activity activities")) return out(DUMPSYS_ACTIVITY);
    if (s.includes("pm list packages")) return out("package:com.android.settings\npackage:com.example.app\n");
    return out("");
  };
  return { exec, calls };
}

function makeAdapter(
  opts: Partial<AndroidAdapterOptions> = {},
  execOverrides: ExecOverrides = {},
): { adapter: AndroidAdapter; calls: RecordedCall[] } {
  const mock = makeExec(execOverrides);
  const adapter = new AndroidAdapter({ deviceId: SERIAL, exec: mock.exec, settleMs: 0, ...opts });
  return { adapter, calls: mock.calls };
}

const j = (c: RecordedCall): string => c.args.join(" ");
const dumpCount = (calls: RecordedCall[]): number => calls.filter((c) => j(c).includes("uiautomator dump")).length;
const hasCall = (calls: RecordedCall[], substr: string): boolean => calls.some((c) => j(c).includes(substr));

function countNodes(n: UINode): number {
  return 1 + (n.children ?? []).reduce((a, c) => a + countNodes(c), 0);
}

// ---------------------------------------------------------------- discovery

describe("adb discovery", () => {
  it("prefers ANDROID_HOME, then the platform default, then PATH", () => {
    const exists = (p: string): boolean => p.includes("chosen");
    const androidHome = discoverAdbPath({
      env: { ANDROID_HOME: "/chosen/sdk", HOME: "/home/u", PATH: "/usr/bin" } as unknown as NodeJS.ProcessEnv,
      platform: "darwin",
      exists,
    });
    expect(androidHome).toBe("/chosen/sdk/platform-tools/adb");

    const darwinDefault = discoverAdbPath({
      env: { HOME: "/chosen/home", PATH: "/usr/bin" } as unknown as NodeJS.ProcessEnv,
      platform: "darwin",
      exists,
    });
    expect(darwinDefault).toBe("/chosen/home/Library/Android/sdk/platform-tools/adb");

    const linuxDefault = discoverAdbPath({
      env: { PATH: "/usr/bin" } as unknown as NodeJS.ProcessEnv,
      platform: "linux",
      exists: (p) => p === "/usr/lib/android-sdk/platform-tools/adb",
    });
    expect(linuxDefault).toBe("/usr/lib/android-sdk/platform-tools/adb");

    const pathHit = discoverAdbPath({
      env: { PATH: "/bin:/chosen/bin" } as unknown as NodeJS.ProcessEnv,
      platform: "linux",
      exists,
    });
    expect(pathHit).toBe("/chosen/bin/adb");

    expect(discoverAdbPath({ env: { PATH: "/bin" } as unknown as NodeJS.ProcessEnv, platform: "linux", exists })).toBeNull();
  });

  it("appends .exe on win32 and orders candidates ANDROID_HOME → default → PATH", () => {
    const cands = adbCandidates({
      env: { ANDROID_HOME: "/sdk", HOME: "/h", PATH: "/bin" } as unknown as NodeJS.ProcessEnv,
      platform: "win32",
    });
    expect(cands[0]).toBe("/sdk/platform-tools/adb.exe");
    expect(cands[cands.length - 1]).toBe("/bin/adb.exe");
    expect(cands.some((c) => c.includes("Library/Android/sdk"))).toBe(false); // darwin default is darwin-only
  });
});

// ---------------------------------------------------------------- devices parse

describe("adb devices parse", () => {
  it("parses serial/model/state from `devices -l`", () => {
    const devs = parseDevices(DEVICES_MULTI);
    expect(devs).toHaveLength(4);
    expect(devs[0]).toMatchObject({ serial: "emulator-5554", state: "device", model: "sdk_gphone64_x86_64" });
    expect(devs[1]).toMatchObject({ serial: "PIXEL7A", state: "device", model: "Pixel_7a" });
    expect(devs[2]).toMatchObject({ serial: "PIXEL6OFF", state: "offline" });
    expect(devs[3]).toMatchObject({ serial: "PIXEL6AUTH", state: "unauthorized" });
  });

  it("maps adb stderr to honest error codes", async () => {
    const mk = (stderr: string): AdbExecFn => async () => ({ code: 1, stdout: "", stdoutBuffer: Buffer.alloc(0), stderr });
    await expect(new AdbClient({ adbPath: "/fake", exec: mk("error: device offline") }).device("S", ["shell", "x"])).rejects.toMatchObject({
      code: "device_offline",
    });
    const unauth = new AdbClient({ adbPath: "/fake", exec: mk("error: device unauthorized.") });
    await expect(unauth.device("S", ["shell", "x"])).rejects.toMatchObject({ code: "permission_required", hint: expect.stringContaining("RSA") });
    await expect(
      new AdbClient({ adbPath: "/fake", exec: mk("error: device 'S' not found") }).device("S", ["shell", "x"]),
    ).rejects.toMatchObject({ code: "device_not_found" });
  });
});

// ---------------------------------------------------------------- target/device selection

describe("device selection on open()", () => {
  it("auto-selects the single online device when no deviceId given", async () => {
    const { adapter } = makeAdapter(
      { deviceId: undefined },
      { devices: "List of devices attached\nSOLO123 device product:p model:Nexus_5\n" },
    );
    const info = await adapter.open();
    expect(info).toMatchObject({ id: "android:SOLO123", platform: "android", type: "device", deviceId: "SOLO123", name: "Nexus 5" });
  });

  it("rejects multiple devices without deviceId with invalid_request listing serials", async () => {
    const { adapter } = makeAdapter({ deviceId: undefined });
    await expect(adapter.open()).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("emulator-5554, PIXEL7A"),
    });
  });

  it("offline deviceId → device_offline; unknown → device_not_found", async () => {
    await expect(makeAdapter({ deviceId: "PIXEL6OFF" }).adapter.open()).rejects.toMatchObject({ code: "device_offline" });
    await expect(makeAdapter({ deviceId: "NOPE" }).adapter.open()).rejects.toMatchObject({ code: "device_not_found" });
  });

  it("unauthorized device → permission_required with RSA hint", async () => {
    try {
      await makeAdapter({ deviceId: "PIXEL6AUTH" }).adapter.open();
      expect.unreachable("open should have thrown");
    } catch (e) {
      expect((e as { code: string }).code).toBe("permission_required");
      expect((e as { hint?: string }).hint).toContain("RSA");
    }
  });

  it("single unauthorized device without deviceId → permission_required", async () => {
    const { adapter } = makeAdapter(
      { deviceId: undefined },
      { devices: "List of devices attached\nONLYAUTH unauthorized product:raven model:Pixel_6\n" },
    );
    await expect(adapter.open()).rejects.toMatchObject({ code: "permission_required" });
  });
});

// ---------------------------------------------------------------- dump parsing

describe("uiautomator dump parsing", () => {
  const root = parseDump(dumpXml)!;

  it("builds the full node tree with stable uia: paths", () => {
    expect(root).not.toBeNull();
    expect(countNodes(root)).toBe(18);
    expect(root.id).toBe("uia:0");
    expect(resolveNode(root, "0/0/0/1/2")).not.toBeNull(); // auto_rotate checkbox
    expect(resolveNode(root, "0/9/9")).toBeNull();
  });

  it("maps classes to roles and keeps booleans/bounds", () => {
    const title = findBy(root, { resourceId: "com.android.settings:id/action_bar_title" })[0]!;
    expect(title.role).toBe("text");
    expect(title.value).toBe("Settings");

    const search = findBy(root, { resourceId: "com.android.settings:id/search_button" })[0]!;
    expect(search.role).toBe("image");
    expect(search.clickable).toBe(true);
    expect(search.bounds).toEqual({ x: 900, y: 114, width: 130, height: 130 });

    const bt = findBy(root, { resourceId: "com.android.settings:id/switch_bar" })[0]!;
    expect(bt.role).toBe("switch");
    expect(bt.checked).toBe(true);
    expect(bt.clickable).toBe(true);
    expect(bt.description).toBe("Bluetooth 开关");

    const cb = findBy(root, { role: "checkbox" })[0]!;
    expect(cb.role).toBe("checkbox");
    expect(cb.checked).toBe(false);
    expect(cb.value).toBe("自动旋转屏幕");

    const et = findBy(root, { role: "textfield" })[0]!;
    expect(et.editable).toBe(true);
    expect(et.focused).toBe(true);

    const save = findBy(root, { resourceId: "com.android.settings:id/save_button" })[0]!;
    expect(save.role).toBe("button");
    expect(save.enabled).toBe(true);
    const cancel = findBy(root, { resourceId: "com.android.settings:id/cancel_button" })[0]!;
    expect(cancel.enabled).toBe(false);

    const recycler = findBy(root, { class: "androidx.recyclerview.widget.RecyclerView" })[0]!;
    expect(recycler.role).toBe("list");
    expect(recycler.attributes?.scrollable).toBe(true);
  });

  it("preserves Chinese text and content-desc", () => {
    const wifi = findBy(root, { text: "已连接到家网络" })[0]!;
    expect(wifi.value).toBe("已连接到家网络");
    expect(findBy(root, { contentDesc: "搜索" }).length).toBeGreaterThanOrEqual(1);
  });

  it("parses bounds and computes centers", () => {
    expect(parseBounds("[0,540][1080,668]")).toEqual({ x: 0, y: 540, width: 1080, height: 128 });
    expect(parseBounds("garbage")).toBeUndefined();
    const cb = findBy(root, { resourceId: "com.android.settings:id/auto_rotate" })[0]!;
    expect(centerOf(cb.bounds!)).toEqual({ x: 540, y: 604 });
    expect(centerOf({ x: 816, y: 1000, width: 192, height: 96 })).toEqual(SAVE_BUTTON_CENTER);
  });

  it("classToRole handles androidx and unknown classes", () => {
    expect(classToRole("android.widget.EditText")).toBe("textfield");
    expect(classToRole("androidx.recyclerview.widget.RecyclerView")).toBe("list");
    expect(classToRole("mycompany.ui.FancyButton")).toBe("button");
    expect(classToRole("mycompany.ui.Whatever")).toBe("whatever");
    expect(classToRole("")).toBe("unknown");
  });
});

// ---------------------------------------------------------------- findBy matcher

describe("findBy matcher", () => {
  const root = parseDump(dumpXml)!;

  it("matches resource-id exactly (and bare-suffix)", () => {
    expect(findBy(root, { resourceId: "com.android.settings:id/save_button" })).toHaveLength(1);
    expect(findBy(root, { resourceId: "save_button" })).toHaveLength(1);
    expect(findBy(root, { resourceId: "nope" })).toHaveLength(0);
  });

  it("matches text / content-desc by substring, role exactly, honors index", () => {
    expect(findBy(root, { text: "保存" })).toHaveLength(1);
    expect(findBy(root, { text: "网" })[0]!.value).toBe("已连接到家网络");
    expect(findBy(root, { contentDesc: "搜索" }).length).toBeGreaterThanOrEqual(2); // search button + edittext desc
    expect(findBy(root, { role: "button" })).toHaveLength(2);
    const buttons = findBy(root, { role: "button" });
    expect(buttons[1]!.value).toBe("取消");
    expect(findBy(root, { role: "button", index: 1 })[0]!.value).toBe("取消");
    expect(findBy(root, {})).toHaveLength(0); // empty query matches nothing
  });
});

// ---------------------------------------------------------------- adapter: locate

describe("AndroidAdapter.locate", () => {
  it("returns a uia: element with bounds from a fresh dump", async () => {
    const { adapter } = makeAdapter();
    await adapter.open();
    const hit = await adapter.locate({ resourceId: "com.android.settings:id/save_button" });
    expect(hit?.element.id).toMatch(/^uia:0\//);
    expect(hit?.element.source).toBe("uiautomator");
    expect(hit?.element.role).toBe("button");
    expect(hit?.element.name).toBe("保存");
    expect(hit?.element.bounds).toEqual({ x: 816, y: 1000, width: 192, height: 96 });
    expect(await adapter.locate({ name: "不存在的控件" })).toBeNull();
    expect(await adapter.locate({ css: "#foo" })).toBeNull(); // css unsupported over adb
  });
});

// ---------------------------------------------------------------- adapter: actions

describe("AndroidAdapter.executeAction — semantic flows", () => {
  it("toggle re-dumps, then taps the element center", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.open();
    const root = parseDump(dumpXml)!;
    const cb = findBy(root, { resourceId: "com.android.settings:id/auto_rotate" })[0]!;
    const c = centerOf(cb.bounds!);
    const res = await adapter.executeAction({ type: "toggle", element: cb });
    expect(res.ok).toBe(true);
    expect(res.method).toBe("semantic");
    expect(res.element?.id).toBe(cb.id);
    expect(dumpCount(calls)).toBe(1); // open() does not dump; toggle dumped exactly once
    expect(hasCall(calls, `-s ${SERIAL} shell input tap ${c.x} ${c.y}`)).toBe(true);
  });

  it("toggle to the current state is a no-op (no tap)", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.open();
    const root = parseDump(dumpXml)!;
    const bt = findBy(root, { resourceId: "com.android.settings:id/switch_bar" })[0]!;
    const res = await adapter.executeAction({ type: "toggle", element: bt, value: true });
    expect(res.ok).toBe(true);
    expect(res.detail).toContain("already");
    expect(calls.some((c) => j(c).includes("input tap"))).toBe(false);
  });

  it("set_value taps to focus, clears, then types with %s-encoded spaces (no ADBKeyboard)", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.open();
    expect(adapter.getCapabilities().notes.join("\n")).toContain("ASCII-only");
    const root = parseDump(dumpXml)!;
    const et = findBy(root, { role: "textfield" })[0]!;
    const res = await adapter.executeAction({ type: "set_value", element: et, value: "hello world" });
    expect(res.ok).toBe(true);
    expect(res.method).toBe("semantic");
    expect(hasCall(calls, "shell input tap 540 944")).toBe(true); // edittext center [96,900][984,988]
    expect(hasCall(calls, "input keyevent 123")).toBe(true); // MOVE_END
    expect(hasCall(calls, "input keyevent 67 67 67 67 67 67 67 67")).toBe(true); // DEL clear
    expect(hasCall(calls, `input text "hello%sworld"`)).toBe(true);
    expect(hasCall(calls, "am broadcast")).toBe(false);
  });

  it("set_value uses the ADBKeyboard broadcast when the IME is installed (unicode ok)", async () => {
    const { adapter, calls } = makeAdapter({}, { ime: "com.android.adbkeyboard/.AdbIME\n" });
    await adapter.open();
    expect(adapter.getCapabilities().notes.join("\n")).toContain("ADBKeyboard");
    const root = parseDump(dumpXml)!;
    const et = findBy(root, { role: "textfield" })[0]!;
    const res = await adapter.executeAction({ type: "set_value", element: et, value: "你好 world" });
    expect(res.ok).toBe(true);
    expect(hasCall(calls, `ime set com.android.adbkeyboard/.AdbIME`)).toBe(true);
    expect(hasCall(calls, `am broadcast -a ADB_INPUT_TEXT --es msg "你好 world"`)).toBe(true);
  });

  it("type taps the element first and presses enter on submit", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.open();
    const root = parseDump(dumpXml)!;
    const et = findBy(root, { role: "textfield" })[0]!;
    const res = await adapter.executeAction({ type: "type", text: "abc", element: et, submit: true });
    expect(res.ok).toBe(true);
    expect(hasCall(calls, "shell input tap 540 944")).toBe(true);
    expect(hasCall(calls, `input text "abc"`)).toBe(true);
    expect(hasCall(calls, "input keyevent 66")).toBe(true);
  });

  it("set_value on a non-editable element is rejected", async () => {
    const { adapter } = makeAdapter();
    await adapter.open();
    const root = parseDump(dumpXml)!;
    const save = findBy(root, { resourceId: "com.android.settings:id/save_button" })[0]!;
    const res = await adapter.executeAction({ type: "set_value", element: save, value: "x" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("invalid_request");
  });

  it("select opens the control and taps the matching option from a second dump", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.open();
    const root = parseDump(dumpXml)!;
    const wifi = findBy(root, { resourceId: "com.android.settings:id/wifi_entry" })[0]!;
    const res = await adapter.executeAction({ type: "select", element: wifi, value: "保存" });
    expect(res.ok).toBe(true);
    expect(dumpCount(calls)).toBe(2); // resolve + option lookup
    expect(hasCall(calls, `-s ${SERIAL} shell input tap ${SAVE_BUTTON_CENTER.x} ${SAVE_BUTTON_CENTER.y}`)).toBe(true);
  });

  it("click falls back to physical-pixel coordinates (default space = physical, normalized maps over screen)", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.open();
    await adapter.executeAction({ type: "click", point: { x: 10, y: 20 } });
    expect(hasCall(calls, "shell input tap 10 20")).toBe(true);
    await adapter.executeAction({ type: "click", point: { x: 500, y: 500, space: "normalized" } });
    expect(hasCall(calls, "shell input tap 540 1170")).toBe(true); // 1080x2340 center
  });

  it("double_click issues two taps; long_press is a zero-distance swipe", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.open();
    const root = parseDump(dumpXml)!;
    const save = findBy(root, { resourceId: "com.android.settings:id/save_button" })[0]!;
    await adapter.executeAction({ type: "double_click", element: save });
    expect(calls.filter((c) => j(c).includes("shell input tap 912 1048"))).toHaveLength(2);
    await adapter.executeAction({ type: "long_press", element: save, durationMs: 900 });
    expect(hasCall(calls, "input swipe 912 1048 912 1048 900")).toBe(true);
  });

  it("scroll down swipes upward at proportional distance", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.open();
    const res = await adapter.executeAction({ type: "scroll", direction: "down" });
    expect(res.ok).toBe(true);
    expect(hasCall(calls, "input swipe 540 1710 540 630 300")).toBe(true);
  });

  it("stale path re-resolves by resource-id; unmatchable elements → element_not_found", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.open();
    const stale = { id: "uia:9/9/9", source: "uiautomator" as const, attributes: { "resource-id": "com.android.settings:id/save_button" } };
    const res = await adapter.executeAction({ type: "click", element: stale });
    expect(res.ok).toBe(true);
    expect(hasCall(calls, "shell input tap 912 1048")).toBe(true);

    const ghost = { id: "uia:9/9/9", source: "uiautomator" as const };
    const miss = await adapter.executeAction({ type: "click", element: ghost });
    expect(miss.ok).toBe(false);
    expect(miss.error?.code).toBe("element_not_found");
  });

  it("rejects foreign-source elements", async () => {
    const { adapter } = makeAdapter();
    await adapter.open();
    const res = await adapter.executeAction({ type: "click", element: { id: "ax:1/2", source: "ax" } });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("invalid_request");
  });
});

describe("AndroidAdapter.executeAction — system flows", () => {
  it("back=KEYCODE 4, home=3, press enter=66, recents via app_switch=187", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.open();
    expect((await adapter.executeAction({ type: "back" })).method).toBe("system");
    expect(hasCall(calls, "input keyevent 4")).toBe(true);
    await adapter.executeAction({ type: "home" });
    expect(hasCall(calls, "input keyevent 3")).toBe(true);
    await adapter.executeAction({ type: "press", key: "enter" });
    expect(hasCall(calls, "input keyevent 66")).toBe(true);
    await adapter.executeAction({ type: "press", key: "app_switch" });
    expect(hasCall(calls, "input keyevent 187")).toBe(true);
    const bad = await adapter.executeAction({ type: "press", key: "meta" });
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe("unsupported");
  });

  it("launch_app uses monkey (or am start for components); terminate_app force-stops", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.open();
    expect((await adapter.executeAction({ type: "launch_app", app: "com.android.settings" })).ok).toBe(true);
    expect(hasCall(calls, "shell monkey -p com.android.settings -c android.intent.category.LAUNCHER 1")).toBe(true);
    await adapter.executeAction({ type: "launch_app", app: "com.android.settings/.DisplaySettings" });
    expect(hasCall(calls, "am start -n com.android.settings/.DisplaySettings")).toBe(true);
    await adapter.executeAction({ type: "terminate_app", app: "com.example.app" });
    expect(hasCall(calls, "am force-stop com.example.app")).toBe(true);
  });
});

// ---------------------------------------------------------------- screenshot / screen state

describe("screenshot + screen geometry", () => {
  it("parses wm size / wm density (override wins)", () => {
    expect(parseWmSize("Physical size: 1080x2340\n")).toEqual({ width: 1080, height: 2340 });
    expect(parseWmSize("Physical size: 1080x2340\nOverride size: 1080x2280\n")).toEqual({ width: 1080, height: 2280 });
    expect(parseWmSize("junk")).toBeNull();
    expect(parseWmDensity("Physical density: 440\n")).toBe(440);
    expect(parseWmDensity("Physical density: 420\nOverride density: 480\n")).toBe(480);
  });

  it("screencap bytes go through processScreenshot; scale = density/160", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.open();
    const shot = await adapter.screenshot();
    expect(shot.format).toBe("png");
    expect(shot.width).toBe(320);
    expect(shot.height).toBe(640);
    expect(shot.scale).toBeCloseTo(2.75); // 440dpi / 160
    expect(shot.orientation).toBe("portrait");
    expect(shot.hash).toHaveLength(16);
    expect(Buffer.from(shot.dataBase64, "base64").subarray(0, 2)).toEqual(Buffer.from([0x89, 0x50]));
    const cap = calls.find((c) => j(c).includes("screencap"));
    expect(cap?.opts?.binary).toBe(true);
    expect(j(cap!)).toContain("exec-out");
  });

  it("observe exposes logical screen info, ui tree and the top activity", async () => {
    const { adapter } = makeAdapter();
    await adapter.open();
    const obs = await adapter.observe();
    expect(obs.target.type).toBe("device");
    expect(obs.screen.displays[0]!.scale).toBeCloseTo(2.75);
    expect(obs.screen.width).toBe(393); // 1080 / 2.75
    expect(obs.screen.height).toBe(851); // 2340 / 2.75
    expect(obs.uiTree).not.toBeUndefined();
    expect(obs.activeApp?.identifier).toBe("com.android.settings");
    expect(obs.activeApp?.name).toBe("Settings");
    expect(obs.screenshot).toBeDefined();
  });

  it("user_rotation drives the reported screen orientation", async () => {
    const { adapter } = makeAdapter({}, { rotation: "1" });
    await adapter.open();
    const obs = await adapter.observe({ includeScreenshot: false, includeUITree: false });
    expect(obs.screen.orientation).toBe("landscape");
  });
});

// ---------------------------------------------------------------- apps/windows

describe("listApps / listWindows", () => {
  it("lists third-party packages with frontmost flag", async () => {
    const { adapter } = makeAdapter();
    await adapter.open();
    const apps = await adapter.listApps();
    expect(apps).toHaveLength(2);
    expect(apps[0]).toMatchObject({ name: "com.android.settings", identifier: "com.android.settings", frontmost: true });
    expect(apps[1]?.frontmost).toBe(false);
  });

  it("windows = the resumed activity only (honest adb limitation)", async () => {
    const { adapter } = makeAdapter();
    await adapter.open();
    const wins = await adapter.listWindows();
    expect(wins).toHaveLength(1);
    expect(wins[0]).toMatchObject({ title: "Settings", app: "com.android.settings", focused: true });
  });
});

// ---------------------------------------------------------------- probe

describe("androidProbe", () => {
  it("available when adb found and ≥1 device online", async () => {
    const p = await androidProbe({ adbPath: "/fake/adb", exec: makeExec().exec });
    expect(p.available).toBe(true);
    expect(JSON.stringify(p.details)).toContain("emulator-5554");
  });

  it("unavailable without adb or without online devices (never throws)", async () => {
    const noAdb = await androidProbe({ discover: () => null });
    expect(noAdb.available).toBe(false);
    expect(noAdb.reason).toContain("adb");

    const unauth = await androidProbe({
      adbPath: "/fake/adb",
      exec: makeExec({ devices: "List of devices attached\nX unauthorized model:P\n" }).exec,
    });
    expect(unauth.available).toBe(false);
    expect(unauth.reason).toContain("unauthorized");

    const none = await androidProbe({
      adbPath: "/fake/adb",
      exec: makeExec({ devices: "List of devices attached\n" }).exec,
    });
    expect(none.available).toBe(false);
    expect(none.reason).toContain("no Android devices");
  });
});

// ---------------------------------------------------------------- misc semantics

describe("misc semantics", () => {
  it("quoteDeviceArg escapes device-shell metacharacters", () => {
    expect(quoteDeviceArg("a b")).toBe('"a b"');
    expect(quoteDeviceArg('say "hi" $now')).toBe('"say \\"hi\\" \\$now"');
  });

  it("executeAction wraps thrown errors into ok:false results", async () => {
    const { adapter } = makeAdapter({ deviceId: "PIXEL6AUTH" });
    const res = await adapter.executeAction({ type: "back" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("invalid_request"); // not open
  });
});
