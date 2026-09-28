/**
 * Linux PlatformAdapter unit tests — hermetic by construction.
 * Every process execution goes through an injected fake `exec`; no real
 * Linux tool (xdotool/wmctrl/grim/…) is ever launched, even on a Linux CI host.
 */
import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import type { RunResult } from "../../src/platforms/exec.js";
import type { ElementRef } from "../../src/core/types.js";
import {
  detectSession,
  probeLinux,
  whichAll,
  type ExecFn,
  type LinuxEnv,
} from "../../src/platforms/linux/session.js";
import * as x11 from "../../src/platforms/linux/x11.js";
import * as atspi from "../../src/platforms/linux/atspi.js";
import { LinuxAdapter, buildCapabilities, linuxProbe } from "../../src/platforms/linux/adapter.js";

// ---------------------------------------------------------------------------
// Fake exec plumbing
// ---------------------------------------------------------------------------

interface FakeCall {
  cmd: string;
  args: string[];
}

function makeExec(cfg: {
  tools?: string[];
  pyatspi?: boolean;
  respond?: (call: FakeCall) => RunResult | undefined | Promise<RunResult | undefined>;
}): { exec: ExecFn; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "which") {
      return { code: (cfg.tools ?? []).includes(args[0] ?? "") ? 0 : 1, stdout: "", stderr: "" };
    }
    if (cmd === "python3" && args[1] === "import pyatspi") {
      return { code: cfg.pyatspi ? 0 : 1, stdout: "", stderr: "" };
    }
    const r = await cfg.respond?.({ cmd, args });
    if (r) return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

function writePngRespond(dimensions: { width: number; height: number } = { width: 64, height: 48 }) {
  return async (call: FakeCall): Promise<RunResult | undefined> => {
    if (["import", "scrot", "gnome-screenshot", "grim"].includes(call.cmd)) {
      const file = call.args[call.args.length - 1]!;
      const png = new PNG({ width: dimensions.width, height: dimensions.height });
      for (let i = 0; i < png.data.length; i += 4) {
        png.data[i] = 20;
        png.data[i + 1] = 30;
        png.data[i + 2] = 40;
        png.data[i + 3] = 255;
      }
      // The fake exec awaits this handler, so the file is fully on disk
      // before the adapter proceeds to readFile().
      await writeFile(file, PNG.sync.write(png));
      return { code: 0, stdout: "", stderr: "" };
    }
    return undefined;
  };
}

const X11_ENV: LinuxEnv = { XDG_SESSION_TYPE: "x11", DISPLAY: ":0", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" };
const WAYLAND_ENV: LinuxEnv = { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "GNOME" };
const SWAY_ENV: LinuxEnv = { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-1", XDG_CURRENT_DESKTOP: "sway" };

const ALL_X11_TOOLS = [
  "xdotool", "wmctrl", "import", "scrot", "gnome-screenshot",
  "xclip", "xsel", "xrandr", "python3", "gtk-launch", "gio", "killall",
];

function x11Adapter(cfg: { tools?: string[]; pyatspi?: boolean; respond?: (call: FakeCall) => RunResult | undefined }) {
  const { exec, calls } = makeExec({ tools: cfg.tools ?? ALL_X11_TOOLS, pyatspi: cfg.pyatspi ?? true, respond: cfg.respond });
  const adapter = new LinuxAdapter({ exec, env: X11_ENV, hostPlatform: "linux" });
  return { adapter, calls };
}

function waylandAdapter(cfg: { tools?: string[]; pyatspi?: boolean; respond?: (call: FakeCall) => RunResult | undefined }) {
  const { exec, calls } = makeExec({ tools: cfg.tools ?? [], pyatspi: cfg.pyatspi ?? false, respond: cfg.respond });
  const adapter = new LinuxAdapter({ exec, env: WAYLAND_ENV, hostPlatform: "linux" });
  return { adapter, calls };
}

// ---------------------------------------------------------------------------
// 1. Session detection
// ---------------------------------------------------------------------------

describe("detectSession", () => {
  it("detects X11 from XDG_SESSION_TYPE", () => {
    const s = detectSession({ XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" });
    expect(s.session).toBe("x11");
    expect(s.wlrootsFamily).toBe(false);
  });

  it("detects X11 from DISPLAY alone (WAYLAND_DISPLAY absence)", () => {
    const s = detectSession({ DISPLAY: ":1" });
    expect(s.session).toBe("x11");
  });

  it("Wayland wins when WAYLAND_DISPLAY is set even if session type says x11", () => {
    const s = detectSession({ XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" });
    expect(s.session).toBe("wayland");
  });

  it("detects Wayland from XDG_SESSION_TYPE", () => {
    const s = detectSession({ XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "GNOME" });
    expect(s.session).toBe("wayland");
    expect(s.wlrootsFamily).toBe(false);
    expect(s.compositor).toContain("GNOME");
  });

  it("flags wlroots-family compositors (sway)", () => {
    const s = detectSession({ XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-1", XDG_CURRENT_DESKTOP: "sway" });
    expect(s.session).toBe("wayland");
    expect(s.wlrootsFamily).toBe(true);
  });

  it("reports tty and unknown honestly", () => {
    expect(detectSession({ XDG_SESSION_TYPE: "tty" }).session).toBe("tty");
    expect(detectSession({}).session).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// 2. wmctrl parsing
// ---------------------------------------------------------------------------

describe("wmctrl -l -G parsing", () => {
  const SAMPLE = [
    "0x01c00007  0 12345   myhost    64 65 1210 1013  GNOME Calculator",
    "0x02600003 -1 6789    myhost     0  0 1920 1080 Desktop",
    "0x03000007  2 777     myhost  -400 -200 800 600 Utf-8 《标题》 with spaces",
    "garbage line that does not match",
    "",
  ].join("\n");

  it("parses id, geometry and title (spaces preserved in titles)", () => {
    const wins = x11.parseWmctrlListG(SAMPLE);
    expect(wins).toHaveLength(3);
    expect(wins[0]!.id).toBe("0x01c00007");
    expect(wins[0]!.bounds).toEqual({ x: 64, y: 65, width: 1210, height: 1013 });
    expect(wins[0]!.title).toBe("GNOME Calculator");
    expect(wins[1]!.bounds).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(wins[2]!.title).toBe("Utf-8 《标题》 with spaces");
  });

  it("does not invent focused/minimized state", () => {
    const wins = x11.parseWmctrlListG(SAMPLE);
    for (const w of wins) {
      expect(w.focused).toBeUndefined();
      expect(w.minimized).toBeUndefined();
    }
  });

  it("parses wmctrl -l -x (WM_CLASS rows)", () => {
    const entries = x11.parseWmctrlListX(
      ["0x01c00007  0 navigator.firefox  myhost Mozilla Firefox", "0x02a00003  2 gnome-calculator.gnome-calcul  myhost Calculator"].join("\n"),
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]!.wmClass).toBe("navigator.firefox");
    expect(entries[1]!.title).toBe("Calculator");
  });
});

// ---------------------------------------------------------------------------
// 3. xdotool builders & parsers
// ---------------------------------------------------------------------------

describe("xdotool helpers", () => {
  it("parses getactivewindow decimal id and converts to wmctrl hex", () => {
    expect(x11.parseXdotoolWindowId("44040195\n")).toBe("44040195");
    expect(x11.parseXdotoolWindowId("failed to get active window")).toBeNull();
    expect(x11.toWmctrlId("44040195")).toBe("0x02a00003");
    expect(x11.toWmctrlId("0x02A00003")).toBe("0x02a00003");
  });

  it("parses getwindowgeometry --shell output", () => {
    const rect = x11.parseXdotoolGeometryShell("WINDOW=44040195\nX=88\nY=190\nWIDTH=1742\nHEIGHT=1010\nSCREEN=0\n");
    expect(rect).toEqual({ x: 88, y: 190, width: 1742, height: 1010 });
    expect(x11.parseXdotoolGeometryShell("WINDOW=1\n")).toBeNull();
  });

  it("parses getdisplaygeometry", () => {
    expect(x11.parseXdotoolDisplayGeometry("1920 1080\n")).toEqual({ width: 1920, height: 1080 });
    expect(x11.parseXdotoolDisplayGeometry("nope")).toBeNull();
  });

  it("builds chained xdotool invocations", () => {
    expect(x11.buildMouseMove(120, 80)).toEqual(["mousemove", "120", "80"]);
    expect(x11.buildClick(120, 80)).toEqual(["mousemove", "120", "80", "click", "1"]);
    expect(x11.buildClick(5, 6, "right")).toEqual(["mousemove", "5", "6", "click", "3"]);
    expect(x11.buildClick(5, 6, "left", 2)).toEqual(["mousemove", "5", "6", "click", "--repeat", "2", "1"]);
    expect(x11.buildScroll(10, 20, "down", 2)).toEqual(["mousemove", "10", "20", "click", "--repeat", "2", "5"]);
    expect(x11.buildScroll(10, 20, "up", 1)).toEqual(["mousemove", "10", "20", "click", "4"]);
    expect(x11.buildTypeText("hello")).toEqual(["type", "--clearmodifiers", "--", "hello"]);
    expect(x11.buildKey("Return")).toEqual(["key", "Return"]);
    expect(x11.buildCombo(["ctrl", "c"])).toEqual(["key", "ctrl+c"]);
    expect(x11.buildCombo(["cmd", "shift", "s"])).toEqual(["key", "super+shift+s"]);
  });

  it("builds a multi-move drag sequence", () => {
    const args = x11.buildDrag({ x: 0, y: 0 }, { x: 100, y: 50 }, 4);
    expect(args[0]).toBe("mousemove");
    expect(args).toContain("mousedown");
    expect(args[args.length - 2]).toBe("mouseup");
    // interpolated midpoints present
    expect(args).toEqual(expect.arrayContaining(["mousemove", "25", "13", "mousemove", "50", "25"]));
  });

  it("reads PNG size from IHDR", () => {
    const png = PNG.sync.write(new PNG({ width: 320, height: 240 }));
    expect(x11.readPngSize(png)).toEqual({ width: 320, height: 240 });
    expect(() => x11.readPngSize(Buffer.from("definitely not a png"))).toThrow(/PNG/);
  });
});

describe("screenshot tool selection (X11)", () => {
  it("prefers import > scrot > gnome-screenshot", () => {
    expect(x11.pickScreenshotTool({ import: true, scrot: true, "gnome-screenshot": true })).toBe("import");
    expect(x11.pickScreenshotTool({ scrot: true, "gnome-screenshot": true })).toBe("scrot");
    expect(x11.pickScreenshotTool({ "gnome-screenshot": true })).toBe("gnome-screenshot");
    expect(x11.pickScreenshotTool({})).toBeNull();
  });

  it("builds per-tool args; null when the tool cannot serve the target", () => {
    expect(x11.buildScreenshotArgs("import", { windowId: "0x02a00003" })).toEqual(["-window", "0x02a00003"]);
    expect(x11.buildScreenshotArgs("import", { region: { x: 1, y: 2, width: 30, height: 40 } })).toEqual([
      "-window", "root", "-crop", "30x40+1+2",
    ]);
    expect(x11.buildScreenshotArgs("scrot", {})).toEqual([]);
    expect(x11.buildScreenshotArgs("scrot", { region: { x: 1, y: 2, width: 30, height: 40 } })).toEqual(["-a", "1,2,30,40"]);
    expect(x11.buildScreenshotArgs("scrot", { windowId: "0x02a00003" })).toBeNull();
    expect(x11.buildScreenshotArgs("gnome-screenshot", {})).toEqual([]);
    expect(x11.buildScreenshotArgs("gnome-screenshot", { windowId: "0x1" })).toEqual(["-w"]);
    expect(x11.buildScreenshotArgs("gnome-screenshot", { region: { x: 0, y: 0, width: 1, height: 1 } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. AT-SPI python JSON-lines parsing (pure TS)
// ---------------------------------------------------------------------------

const APP_REC = { d: 0, p: "1", role: "application", name: "gnome-calculator", desc: "", app: "gnome-calculator", st: { enabled: true, visible: true }, ext: [0, 0, 400, 600], text: null, acts: [] };
const FRAME_REC = { d: 1, p: "1/0", role: "frame", name: "Calculator", desc: "main window", app: "gnome-calculator", st: { enabled: true }, ext: [0, 0, 400, 600], text: null, acts: [] };
const BTN_REC = { d: 2, p: "1/0/3", role: "push button", name: "7", desc: "", app: "gnome-calculator", st: { enabled: true, focused: true }, ext: [100, 200, 40, 40], text: null, acts: ["press"] };
const TXT_REC = { d: 2, p: "1/0/4", role: "text", name: "Display", desc: "", app: "gnome-calculator", st: { enabled: true, editable: true }, ext: [10, 10, 380, 50], text: "0", acts: [] };

function walkOutput(): string {
  return [APP_REC, FRAME_REC, BTN_REC, TXT_REC, { ok: false, error: "accessibility bus unavailable: no dbus" }, "not-json-at-all"]
    .map((r) => (typeof r === "string" ? r : JSON.stringify(r)))
    .join("\n");
}

describe("AT-SPI JSON-lines parsing", () => {
  it("parses nodes and collects errors without throwing", () => {
    const { nodes, errors } = atspi.parseAtspiNodes(walkOutput());
    expect(nodes).toHaveLength(4);
    expect(errors).toEqual(["accessibility bus unavailable: no dbus", "unparseable AT-SPI line: not-json-at-all"]);
    const btn = nodes[2]!;
    expect(btn.role).toBe("push button");
    expect(btn.name).toBe("7");
    expect(btn.states.focused).toBe(true);
    expect(btn.extents).toEqual({ x: 100, y: 200, width: 40, height: 40 });
    expect(btn.actions).toEqual(["press"]);
    expect(nodes[3]!.text).toBe("0");
  });

  it("maps AT-SPI roles to unified roles", () => {
    expect(atspi.normalizeAtspiRole("push button")).toBe("button");
    expect(atspi.normalizeAtspiRole("toggle button")).toBe("togglebutton");
    expect(atspi.normalizeAtspiRole("check box")).toBe("checkbox");
    expect(atspi.normalizeAtspiRole("text")).toBe("textfield");
    expect(atspi.normalizeAtspiRole("page tab")).toBe("tab");
    expect(atspi.normalizeAtspiRole("frame")).toBe("window");
    expect(atspi.normalizeAtspiRole("some future role")).toBe("some_future_role");
  });

  it("builds a UINode tree from the flat depth list", () => {
    const { nodes } = atspi.parseAtspiNodes(walkOutput());
    const tree = atspi.atspiToTree(nodes);
    expect(tree).not.toBeNull();
    expect(tree!.id).toBe("atspi:1");
    expect(tree!.source).toBe("atspi");
    expect(tree!.role).toBe("application");
    const frame = tree!.children![0]!;
    expect(frame.role).toBe("window");
    const [btn, txt] = frame.children!;
    expect(btn!.id).toBe("atspi:1/0/3");
    expect(btn!.role).toBe("button");
    expect(btn!.clickable).toBe(true);
    expect(btn!.focused).toBe(true);
    expect(btn!.bounds).toEqual({ x: 100, y: 200, width: 40, height: 40 });
    expect(txt!.role).toBe("textfield");
    expect(txt!.editable).toBe(true);
    expect(txt!.value).toBe("0");
    expect(btn!.attributes!.atspiPath).toBe("1/0/3");
  });

  it("parses act/settext single-record results", () => {
    expect(atspi.parseAtspiResult('{"ok":true,"action":"press","index":0,"acts":["press"]}\n')).toEqual({
      ok: true, action: "press", index: 0, actions: ["press"],
    });
    const r = atspi.parseAtspiResult('{"ok":false,"error":"element exposes no AT-SPI Action interface"}\n');
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Action interface");
    expect(atspi.parseAtspiResult("").ok).toBe(false);
  });

  it("builds python argv for walk/act/settext", () => {
    expect(atspi.buildAtspiWalkArgs({ app: "calc", maxDepth: 5, maxNodes: 50 })).toEqual([
      "-c", atspi.ATSPI_SCRIPT, "walk", "--max-depth", "5", "--max-nodes", "50", "--app", "calc",
    ]);
    expect(atspi.buildAtspiActArgs("1/0/3")).toEqual(["-c", atspi.ATSPI_SCRIPT, "act", "1/0/3"]);
    expect(atspi.buildAtspiSetTextArgs("1/0/4", "42")).toEqual(["-c", atspi.ATSPI_SCRIPT, "settext", "1/0/4", "42"]);
  });
});

// ---------------------------------------------------------------------------
// 5. Capabilities matrix
// ---------------------------------------------------------------------------

describe("capabilities matrix", () => {
  it("X11 with every tool + pyatspi: fully capable", async () => {
    const { exec } = makeExec({ tools: ALL_X11_TOOLS, pyatspi: true });
    const d = await probeLinux(exec, X11_ENV);
    const caps = buildCapabilities(d);
    expect(caps).toMatchObject({
      screenshot: true,
      accessibility: true,
      globalInput: true,
      windowControl: true,
      appControl: true,
      clipboard: true,
      multiDisplay: true,
      dom: false,
    });
    expect(caps.notes?.join(" ")).toContain("fractional scaling");
  });

  it("X11 with only xdotool and no pyatspi: honest gaps + install hints", async () => {
    const { exec } = makeExec({ tools: ["xdotool"], pyatspi: false });
    const d = await probeLinux(exec, X11_ENV);
    const caps = buildCapabilities(d);
    expect(caps.screenshot).toBe(false);
    expect(caps.windowControl).toBe(false);
    expect(caps.accessibility).toBe(false);
    expect(caps.globalInput).toBe(true);
    const notes = caps.notes?.join(" ") ?? "";
    expect(notes).toContain("scrot");
    expect(notes).toContain("wmctrl");
    expect(notes).toContain("pyatspi");
  });

  it("X11 without xdotool: globalInput false", async () => {
    const { exec } = makeExec({ tools: ["scrot", "wmctrl", "python3"], pyatspi: true });
    const d = await probeLinux(exec, X11_ENV);
    const caps = buildCapabilities(d);
    expect(caps.screenshot).toBe(true);
    expect(caps.windowControl).toBe(true);
    expect(caps.globalInput).toBe(false);
    expect(caps.accessibility).toBe(true);
  });

  it("Wayland wlroots with grim+wtype: capture+input work, window control does not", async () => {
    const { exec } = makeExec({ tools: ["grim", "wtype", "python3"], pyatspi: true });
    const d = await probeLinux(exec, SWAY_ENV);
    const caps = buildCapabilities(d);
    expect(caps.screenshot).toBe(true);
    expect(caps.globalInput).toBe(true);
    expect(caps.windowControl).toBe(false);
    expect(caps.accessibility).toBe(true);
    expect(caps.notes?.join(" ")).toContain("compositor");
  });

  it("Wayland ydotool without ydotoold: input claimed but daemon limitation noted", async () => {
    const { exec } = makeExec({ tools: ["ydotool"], pyatspi: false });
    const d = await probeLinux(exec, WAYLAND_ENV);
    const caps = buildCapabilities(d);
    expect(caps.globalInput).toBe(true);
    expect(caps.screenshot).toBe(false);
    expect(caps.notes?.join(" ")).toContain("ydotoold");
  });

  it("GNOME-Wayland with nothing: everything false, portal mentioned", async () => {
    const { exec } = makeExec({ tools: [], pyatspi: false });
    const d = await probeLinux(exec, WAYLAND_ENV);
    const caps = buildCapabilities(d);
    expect(caps.screenshot).toBe(false);
    expect(caps.globalInput).toBe(false);
    expect(caps.windowControl).toBe(false);
    expect(caps.accessibility).toBe(false);
    const notes = caps.notes?.join(" ") ?? "";
    expect(notes).toContain("org.freedesktop.portal.Screenshot");
    expect(notes).toContain("wtype");
  });
});

// ---------------------------------------------------------------------------
// 6. X11 adapter behavior (fake exec end-to-end)
// ---------------------------------------------------------------------------

describe("X11 adapter", () => {
  it("opens and reports target info", async () => {
    const { adapter } = x11Adapter({});
    const info = await adapter.open();
    expect(info.platform).toBe("linux");
    expect(info.name).toContain("X11");
    expect(adapter.getCapabilities().screenshot).toBe(true);
  });

  it("refuses to open without a graphical session", async () => {
    const { exec } = makeExec({ tools: ALL_X11_TOOLS, pyatspi: true });
    const adapter = new LinuxAdapter({ exec, env: { XDG_SESSION_TYPE: "tty" }, hostPlatform: "linux" });
    await expect(adapter.open()).rejects.toMatchObject({ code: "restricted" });
  });

  it("throws unsupported off a linux host", async () => {
    const { exec } = makeExec({ tools: ALL_X11_TOOLS });
    const adapter = new LinuxAdapter({ exec, env: X11_ENV, hostPlatform: "darwin" });
    await expect(adapter.open()).rejects.toMatchObject({ code: "unsupported" });
  });

  it("captures a screenshot through scrot and reports pixel space", async () => {
    const { adapter, calls } = x11Adapter({ tools: ["scrot", "xdotool", "wmctrl"], respond: writePngRespond() });
    await adapter.open();
    const shot = await adapter.screenshot();
    expect(shot.format).toBe("png");
    expect(shot.width).toBe(64);
    expect(shot.height).toBe(48);
    expect(shot.scale).toBe(1);
    expect(shot.origin).toEqual({ x: 0, y: 0 });
    expect(calls.find((c) => c.cmd === "scrot")).toBeDefined();
  });

  it("captures a window by id via import", async () => {
    const { adapter, calls } = x11Adapter({ tools: ["import"], respond: writePngRespond() });
    await adapter.open();
    const shot = await adapter.screenshot({ windowId: "0x02a00003" });
    expect(shot.width).toBe(64);
    const call = calls.find((c) => c.cmd === "import");
    expect(call?.args.slice(0, 2)).toEqual(["-window", "0x02a00003"]);
  });

  it("marks the focused window from xdotool getactivewindow", async () => {
    const { adapter, calls } = x11Adapter({
      respond: (c) => {
        if (c.cmd === "xdotool" && c.args[0] === "getactivewindow") return { code: 0, stdout: "44040195\n" };
        if (c.cmd === "wmctrl" && c.args[0] === "-l" && c.args[1] === "-G") {
          return { code: 0, stdout: "0x02a00003  0 1234 host 0 0 800 600 Calc\n0x01c00007  0 1234 host 10 10 400 300 Other\n" };
        }
        return undefined;
      },
    });
    await adapter.open();
    const wins = await adapter.listWindows();
    expect(wins).toHaveLength(2);
    expect(wins.find((w) => w.id === "0x02a00003")?.focused).toBe(true);
    expect(wins.find((w) => w.id === "0x01c00007")?.focused).toBeUndefined();
    expect(calls.length).toBeGreaterThan(0);
  });

  it("performs semantic click via AT-SPI act for atspi elements", async () => {
    const { adapter, calls } = x11Adapter({
      respond: (c) => {
        if (c.cmd === "python3" && c.args[2] === "act") return { code: 0, stdout: '{"ok":true,"action":"press","index":0,"acts":["press"]}\n' };
        return undefined;
      },
    });
    await adapter.open();
    const el: ElementRef = {
      id: "atspi:1/0/3",
      source: "atspi",
      role: "button",
      name: "Save",
      bounds: { x: 10, y: 20, width: 80, height: 30 },
      attributes: { app: "app", atspiPath: "1/0/3" },
    };
    const r = await adapter.executeAction({ type: "click", element: el });
    expect(r.ok).toBe(true);
    expect(r.method).toBe("semantic");
    expect(r.detail).toContain("atspi:press");
    expect(calls.find((c) => c.cmd === "python3" && c.args[2] === "act")?.args[3]).toBe("1/0/3");
    expect(calls.find((c) => c.cmd === "xdotool")).toBeUndefined();
  });

  it("falls back to xdotool coordinates when the semantic action fails", async () => {
    const { adapter, calls } = x11Adapter({
      respond: (c) => {
        if (c.cmd === "python3" && c.args[2] === "act") return { code: 0, stdout: '{"ok":false,"error":"element exposes no AT-SPI Action interface"}\n' };
        return undefined;
      },
    });
    await adapter.open();
    const el: ElementRef = {
      id: "atspi:1/0/3",
      source: "atspi",
      bounds: { x: 10, y: 20, width: 80, height: 30 },
      attributes: { atspiPath: "1/0/3" },
    };
    const r = await adapter.executeAction({ type: "click", element: el });
    expect(r.ok).toBe(true);
    expect(r.method).toBe("coordinate");
    expect(r.point).toEqual({ x: 50, y: 35 });
    expect(calls.find((c) => c.cmd === "xdotool")?.args).toEqual(["mousemove", "50", "35", "click", "1"]);
  });

  it("sends raw input through xdotool with correct args", async () => {
    const { adapter, calls } = x11Adapter({});
    await adapter.open();
    await adapter.executeAction({ type: "click", point: { x: 120, y: 80, space: "logical" } });
    await adapter.executeAction({ type: "type", text: "hello", submit: true });
    await adapter.executeAction({ type: "hotkey", keys: ["ctrl", "c"] });
    await adapter.executeAction({ type: "scroll", direction: "down", amount: 2, point: { x: 5, y: 5 } });

    const xdo = calls.filter((c) => c.cmd === "xdotool").map((c) => c.args);
    expect(xdo).toContainEqual(["mousemove", "120", "80", "click", "1"]);
    expect(xdo).toContainEqual(["type", "--clearmodifiers", "--", "hello"]);
    expect(xdo).toContainEqual(["key", "Return"]);
    expect(xdo).toContainEqual(["key", "ctrl+c"]);
    expect(xdo).toContainEqual(["mousemove", "5", "5", "click", "--repeat", "2", "5"]);
  });

  it("falls back to click+select-all+type for set_value without pyatspi", async () => {
    const { adapter, calls } = x11Adapter({ pyatspi: false });
    await adapter.open();
    const el: ElementRef = { id: "atspi:1/0/4", source: "atspi", bounds: { x: 10, y: 10, width: 100, height: 20 } };
    const r = await adapter.executeAction({ type: "set_value", element: el, value: "abc" });
    expect(r.ok).toBe(true);
    expect(r.method).toBe("coordinate");
    const xdo = calls.filter((c) => c.cmd === "xdotool").map((c) => c.args);
    expect(xdo).toContainEqual(["mousemove", "60", "20", "click", "1"]);
    expect(xdo).toContainEqual(["key", "ctrl+a"]);
    expect(xdo).toContainEqual(["type", "--clearmodifiers", "--", "abc"]);
  });

  it("throws restricted for input when xdotool is missing", async () => {
    const { adapter } = x11Adapter({ tools: ["wmctrl", "scrot"], pyatspi: false });
    await adapter.open();
    const r = await adapter.executeAction({ type: "click", point: { x: 1, y: 2 } });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("restricted");
    expect(r.error?.hint).toContain("xdotool");
  });

  it("executes launch/terminate/focus through the right tools", async () => {
    const { adapter, calls } = x11Adapter({
      respond: (c) => {
        if (c.cmd === "wmctrl" && c.args[0] === "-x") return { code: 0 };
        return undefined;
      },
    });
    await adapter.open();
    await adapter.launchApp("firefox");
    await adapter.terminateApp("firefox");
    await adapter.focusTarget({ windowTitle: "Calculator" });
    await adapter.focusTarget({ app: "gnome-calculator" });
    expect(calls.find((c) => c.cmd === "gtk-launch")?.args[0]).toBe("firefox");
    expect(calls.find((c) => c.cmd === "killall")?.args).toEqual(["firefox"]);
    expect(calls.find((c) => c.cmd === "wmctrl" && c.args[0] === "-a")?.args).toEqual(["-a", "Calculator"]);
    expect(calls.find((c) => c.cmd === "wmctrl" && c.args[0] === "-x")?.args).toEqual(["-x", "-a", "gnome-calculator"]);
  });

  it("reports mobile-only actions as unsupported", async () => {
    const { adapter } = x11Adapter({});
    await adapter.open();
    const r = await adapter.executeAction({ type: "back" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("unsupported");
  });
});

// ---------------------------------------------------------------------------
// 7. Wayland adapter: honest restriction (never faked)
// ---------------------------------------------------------------------------

describe("Wayland adapter", () => {
  it("opens but reports honestly restricted capabilities on bare GNOME-Wayland", async () => {
    const { adapter } = waylandAdapter({});
    const info = await adapter.open();
    expect(info.name).toContain("Wayland");
    const caps = adapter.getCapabilities();
    expect(caps.screenshot).toBe(false);
    expect(caps.globalInput).toBe(false);
    expect(caps.windowControl).toBe(false);
  });

  it("screenshot without grim throws restricted with the portal hint", async () => {
    const { adapter } = waylandAdapter({});
    await adapter.open();
    await expect(adapter.screenshot()).rejects.toMatchObject({
      code: "restricted",
      hint: expect.stringContaining("org.freedesktop.portal.Screenshot"),
    });
  });

  it("pointer input without ydotool+ydotoold throws restricted with uinput hint", async () => {
    const { adapter } = waylandAdapter({ tools: ["wtype"], pyatspi: false });
    await adapter.open();
    const r = await adapter.executeAction({ type: "click", point: { x: 5, y: 5 } });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("restricted");
    expect(r.error?.hint).toContain("uinput");
    const r2 = await adapter.executeAction({ type: "drag", from: { point: { x: 0, y: 0 } }, to: { point: { x: 9, y: 9 } } });
    expect(r2.error?.code).toBe("restricted");
  });

  it("keyboard input flows through wtype when present", async () => {
    const { adapter, calls } = waylandAdapter({ tools: ["grim", "wtype"], pyatspi: false });
    await adapter.open();
    const r = await adapter.executeAction({ type: "type", text: "héllo", submit: true });
    expect(r.ok).toBe(true);
    const wtypeCalls = calls.filter((c) => c.cmd === "wtype").map((c) => c.args);
    expect(wtypeCalls).toContainEqual(["--", "héllo"]);
    expect(wtypeCalls).toContainEqual(["-k", "Return"]);
    await adapter.executeAction({ type: "hotkey", keys: ["ctrl", "c"] });
    expect(calls.filter((c) => c.cmd === "wtype").at(-1)?.args).toEqual(["-M", "ctrl", "-P", "c", "-p", "c", "-m", "ctrl"]);
  });

  it("keyboard restricted without wtype or ydotoold", async () => {
    const { adapter } = waylandAdapter({ tools: ["grim"], pyatspi: false });
    await adapter.open();
    const r = await adapter.executeAction({ type: "type", text: "hi" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("restricted");
    expect(r.error?.hint).toContain("wtype");
  });

  it("capture works through grim when installed", async () => {
    const { adapter, calls } = waylandAdapter({ tools: ["grim"], respond: writePngRespond({ width: 100, height: 60 }) });
    await adapter.open();
    const shot = await adapter.screenshot({ region: { x: 2, y: 3, width: 100, height: 60 } });
    expect(shot.width).toBe(100);
    expect(shot.origin).toEqual({ x: 2, y: 3 });
    const grim = calls.find((c) => c.cmd === "grim")!;
    expect(grim.args[0]).toBe("-g");
    expect(grim.args[1]).toBe("2,3 100x60");
  });

  it("semantic AT-SPI actions still work on Wayland (accessibility bus)", async () => {
    const wired = waylandAdapterWithAct();
    const adapter = waylandAdapter({ tools: ["grim", "wtype", "python3"], pyatspi: true }).adapter;
    await adapter.open();
    const el: ElementRef = { id: "atspi:0/1", source: "atspi", attributes: { atspiPath: "0/1" } };
    const r = await adapter.executeAction({ type: "click", element: el });
    // fake exec returns empty stdout for the act call → parsed as failure → restricted (no pointer fallback on Wayland)
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("restricted");
    // now with a working act response
    await wired.open();
    const r2 = await wired.executeAction({ type: "click", element: el });
    expect(r2.ok).toBe(true);
    expect(r2.method).toBe("semantic");
  });

  it("focus is honestly restricted on Wayland", async () => {
    const { adapter } = waylandAdapter({ tools: ["grim", "wtype"] });
    await adapter.open();
    const r = await adapter.executeAction({ type: "focus", windowTitle: "Files" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("restricted");
    await expect(adapter.focusTarget({ app: "nautilus" })).rejects.toMatchObject({ code: "restricted" });
  });

  it("listWindows is honestly empty on Wayland", async () => {
    const { adapter } = waylandAdapter({ tools: ["grim"] });
    await adapter.open();
    expect(await adapter.listWindows()).toEqual([]);
  });
});

/** Helper: a Wayland adapter whose python3 `act` subcommand succeeds. */
function waylandAdapterWithAct(): LinuxAdapter {
  const { exec } = makeExec({
    tools: ["grim", "wtype", "python3"],
    pyatspi: true,
    respond: (c) => {
      if (c.cmd === "python3" && c.args[2] === "act") {
        return { code: 0, stdout: '{"ok":true,"action":"press","index":0,"acts":["press"]}\n' };
      }
      return undefined;
    },
  });
  return new LinuxAdapter({ exec, env: WAYLAND_ENV, hostPlatform: "linux" });
}

// ---------------------------------------------------------------------------
// 8. probe helper
// ---------------------------------------------------------------------------

describe("linuxProbe", () => {
  it("reports unavailable off a linux host", async () => {
    const probe = await linuxProbe({ hostPlatform: "darwin", env: X11_ENV });
    expect(probe.available).toBe(false);
    expect(probe.reason).toContain("linux host");
  });

  it("reports unavailable without a graphical session", async () => {
    const { exec } = makeExec({ tools: ALL_X11_TOOLS, pyatspi: true });
    const probe = await linuxProbe({ hostPlatform: "linux", env: {}, exec });
    expect(probe.available).toBe(false);
    expect(probe.reason).toContain("graphical session");
  });

  it("reports available with a usable X11 toolset", async () => {
    const { exec } = makeExec({ tools: ALL_X11_TOOLS, pyatspi: true });
    const probe = await linuxProbe({ hostPlatform: "linux", env: X11_ENV, exec });
    expect(probe.available).toBe(true);
    expect(probe.details).toBeDefined();
  });

  it("reports unavailable when nothing usable exists", async () => {
    const { exec } = makeExec({ tools: [], pyatspi: false });
    const probe = await linuxProbe({ hostPlatform: "linux", env: X11_ENV, exec });
    expect(probe.available).toBe(false);
    expect(probe.reason).toContain("xdotool");
  });
});

// ---------------------------------------------------------------------------
// 9. whichAll sanity
// ---------------------------------------------------------------------------

describe("whichAll", () => {
  it("maps found/not-found honestly", async () => {
    const { exec } = makeExec({ tools: ["xdotool"] });
    const tools = await whichAll(exec, ["xdotool", "wmctrl"]);
    expect(tools).toEqual({ xdotool: true, wmctrl: false });
  });
});
