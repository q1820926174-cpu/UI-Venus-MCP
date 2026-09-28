/**
 * Hermetic unit tests for the iOS/iPadOS PlatformAdapter.
 *
 * Everything runs against mocks/fixtures — no Xcode, no simulators, no
 * devices, no network. The dev host has neither simctl nor idb, which is
 * exactly why every exec/fetch boundary is injectable.
 *
 * NOT covered here (cannot be verified on this host — documented honestly):
 * real `xcrun simctl` / `idb` CLI behaviour, real WDA server responses,
 * screenshot pixel content, coordinate-space fidelity on real hardware.
 */
import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import { ComputerUseError } from "../../src/core/errors.js";
import { Simctl, parseListapps, parseSimctlList, probeSimctl, type RunBinaryFn, type RunFn } from "../../src/platforms/ios/simctl.js";
import { Idb, describeAllToTree, parseDescribeAll, parseIdbDescribe, parseIdbElement, probeIdb } from "../../src/platforms/ios/idb.js";
import { WdaClient, parseWdaSource, wdaBaseUrlFromEnv, type FetchFn } from "../../src/platforms/ios/wda.js";
import { IosAdapter, iosProbe } from "../../src/platforms/ios/adapter.js";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const UDID = "UDID-A";

const SIMCTL_LIST = JSON.stringify({
  devicetypes: [],
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-17-4": [
      {
        lastBootedAt: "2026-09-01T10:00:00Z",
        dataPath: "/tmp/dev-a",
        udid: UDID,
        isAvailable: true,
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
        state: "Booted",
        name: "iPhone 15",
      },
      {
        udid: "UDID-B",
        isAvailable: true,
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-SE-Third-Generation",
        state: "Shutdown",
        name: "iPhone SE (3rd generation)",
      },
    ],
  },
});

const LISTAPPS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <dict>
    <key>CFBundleIdentifier</key><string>com.apple.Preferences</string>
    <key>CFBundleDisplayName</key><string>Settings</string>
  </dict>
  <dict>
    <key>CFBundleIdentifier</key><string>com.example.App</string>
    <key>CFBundleName</key><string>Example</string>
  </dict>
</dict></plist>`;

const LISTAPPS_OPENSTEP = `{
  com.apple.Preferences =     {
      CFBundleIdentifier = "com.apple.Preferences";
      CFBundleName = Settings;
  };
  com.example.App =     {
      CFBundleIdentifier = "com.example.App";
      CFBundleDisplayName = Example;
  };
}`;

/** idb ui describe-all: flat JSON array, DFS pre-order, frames in POINTS. */
const IDB_DESCRIBE_ALL = JSON.stringify([
  { type: "Window", AXFrame: { x: 0, y: 0, width: 375, height: 812 } },
  { type: "NavigationBar", AXFrame: { x: 0, y: 0, width: 375, height: 44 } },
  { type: "StaticText", AXLabel: "设置", AXFrame: { x: 150, y: 10, width: 75, height: 24 } },
  { type: "Button", AXLabel: "登录", AXIdentifier: "login-button", AXFrame: { x: 40, y: 600, width: 295, height: 44 }, isEnabled: true },
  { type: "TextField", AXLabel: "搜索", AXIdentifier: "search-field", AXFrame: { x: 20, y: 100, width: 335, height: 36 } },
]);

const IDB_DESCRIBE = JSON.stringify({
  screen_dimensions: { width: 375, height: 812, scale: 2 },
  device: "iPhone 15",
  ios_version: "17.4",
});

/** WDA /source?format=json value: nested tree; frames as CGRect strings AND
 * plain objects (both appear across WDA versions). */
const WDA_SOURCE = {
  type: "Application",
  label: "Settings",
  frame: "{0, 0; 375, 812}",
  children: [
    {
      type: "XCUIElementTypeWindow",
      frame: { x: 0, y: 0, width: 375, height: 812 },
      children: [
        {
          type: "XCUIElementTypeButton",
          label: "登录",
          rawIdentifier: "login-button",
          frame: { x: 40, y: 600, width: 295, height: 44 },
          isEnabled: true,
          children: [],
        },
        {
          type: "XCUIElementTypeTextField",
          label: "搜索",
          rawIdentifier: "search-field",
          frame: "{20, 100; 335, 36}",
          children: [],
        },
        {
          type: "XCUIElementTypeStaticText",
          label: "欢迎",
          frame: { x: 20, y: 200, width: 100, height: 20 },
          children: [],
        },
      ],
    },
  ],
};

function pngBytes(width: number, height: number): Buffer {
  return PNG.sync.write(new PNG({ width, height }));
}

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */

interface RecordedRun {
  cmd: string;
  args: string[];
}
interface RecordedRequest {
  method: string;
  path: string;
  body?: unknown;
}

type RunHandler = { match: (cmd: string, args: string[]) => boolean; result: (cmd: string, args: string[]) => { code: number; stdout: string; stderr: string } };

function makeRun(handlers: RunHandler[]): { calls: RecordedRun[]; run: RunFn } {
  const calls: RecordedRun[] = [];
  const run: RunFn = async (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    for (const h of handlers) if (h.match(cmd, args)) return h.result(cmd, args);
    return { code: 1, stdout: "", stderr: `unmocked: ${cmd} ${args.join(" ")}` };
  };
  return { calls, run };
}

const isXcrunFind = (_cmd: string, args: string[]): boolean => args[0] === "--find" && args[1] === "simctl";
const isWhichIdb = (cmd: string, args: string[]): boolean => cmd === "which" && args[0] === "idb";

type Route = { match: (method: string, path: string) => boolean; respond: (req: RecordedRequest) => unknown };

function makeFetch(routes: Route[]): { calls: RecordedRequest[]; fetchFn: FetchFn } {
  const calls: RecordedRequest[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname + u.search;
    let body: unknown;
    if (init?.body) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const req: RecordedRequest = { method: init?.method ?? "GET", path, body };
    calls.push(req);
    for (const r of routes) {
      if (r.match(req.method, path)) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ value: await r.respond(req) }) };
      }
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ value: { message: `no route for ${path}` } }) };
  };
  return { calls, fetchFn };
}

const unreachableFetch: FetchFn = async () => {
  throw new Error("connect ECONNREFUSED 127.0.0.1:8100");
};

const WDA_SID = "SID-1";

function wdaRoutes(extra: Route[] = []): Route[] {
  return [
    { match: (m, p) => m === "GET" && p === "/status", respond: () => ({ ready: true, state: "success", os: { name: "iOS", version: "17.4" } }) },
    { match: (m, p) => m === "POST" && p === "/session", respond: () => ({ sessionId: WDA_SID, capabilities: {} }) },
    { match: (m, p) => m === "GET" && p === `/session/${WDA_SID}/window/size`, respond: () => ({ width: 375, height: 812 }) },
    { match: (m, p) => m === "GET" && p.startsWith(`/session/${WDA_SID}/source`) && p.includes("format=json"), respond: () => WDA_SOURCE },
    {
      match: (m, p) => m === "POST" && p === `/session/${WDA_SID}/elements`,
      respond: (req) => {
        const value = (req.body as { value?: string })?.value ?? "";
        const eid = value === "login-button" ? "E-LOGIN" : value === "search-field" ? "E-SEARCH" : `E-${value}`;
        return [{ "element-6066-11e4-a52e-4f735466cecf": eid }];
      },
    },
    { match: (m, p) => m === "POST" && p.startsWith(`/session/${WDA_SID}/element/`), respond: () => ({}) },
    { match: (m, p) => m === "POST" && p === `/session/${WDA_SID}/wda/tap/0`, respond: () => ({}) },
    { match: (m, p) => m === "POST" && p === `/session/${WDA_SID}/wda/doubleTap`, respond: () => ({}) },
    { match: (m, p) => m === "POST" && p === `/session/${WDA_SID}/wda/touchAndHold`, respond: () => ({}) },
    { match: (m, p) => m === "POST" && p === `/session/${WDA_SID}/wda/dragfromtoforduration`, respond: () => ({}) },
    { match: (m, p) => m === "POST" && p === `/session/${WDA_SID}/wda/pressHome`, respond: () => ({}) },
    { match: (m, p) => m === "POST" && p === `/session/${WDA_SID}/wda/type`, respond: () => ({}) },
    { match: (m, p) => m === "POST" && p === `/session/${WDA_SID}/wda/keys`, respond: () => ({}) },
    { match: (m, p) => m === "GET" && p === `/session/${WDA_SID}/wda/activeAppInfo`, respond: () => ({ name: "Settings", bundleId: "com.apple.Preferences", pid: 42 }) },
    { match: (m, p) => m === "POST" && p === `/session/${WDA_SID}/wda/apps/launch`, respond: () => ({}) },
    { match: (m, p) => m === "POST" && p === `/session/${WDA_SID}/wda/apps/terminate`, respond: () => ({}) },
    { match: (m, p) => m === "POST" && p === `/session/${WDA_SID}/wda/apps/activate`, respond: () => ({}) },
    { match: (m, p) => m === "POST" && p === `/session/${WDA_SID}/url`, respond: () => ({}) },
    { match: (m, p) => m === "GET" && p === "/screenshot", respond: () => pngBytes(750, 1624).toString("base64") },
    ...extra,
  ];
}

/* ------------------------------------------------------------------ */
/* simctl                                                              */
/* ------------------------------------------------------------------ */

describe("simctl", () => {
  it("parses `simctl list devices -j` (name/udid/state/runtime)", () => {
    const devices = parseSimctlList(SIMCTL_LIST);
    expect(devices).toHaveLength(2);
    expect(devices[0]).toMatchObject({ name: "iPhone 15", udid: UDID, state: "Booted", runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-4" });
    expect(devices[1]).toMatchObject({ name: "iPhone SE (3rd generation)", udid: "UDID-B", state: "Shutdown" });
  });

  it("prefers the booted device, honors explicit UDIDs, throws device_not_found otherwise", () => {
    const simctl = new Simctl();
    const devices = parseSimctlList(SIMCTL_LIST);
    expect(simctl.pickDevice(devices).udid).toBe(UDID);
    expect(simctl.pickDevice(devices, "UDID-B").udid).toBe("UDID-B");
    expect(() => simctl.pickDevice(devices, "NOPE")).toThrowError(expect.objectContaining({ code: "device_not_found" }));
    expect(() => simctl.pickDevice([])).toThrowError(expect.objectContaining({ code: "device_not_found" }));
  });

  it("probe fails honestly without Xcode (xcrun --find simctl)", async () => {
    const { run } = makeRun([{ match: isXcrunFind, result: () => ({ code: 69, stdout: "", stderr: "xcrun: error: unable to find utility \"simctl\"" }) }]);
    const probe = await probeSimctl(run);
    expect(probe.ok).toBe(false);
    expect(probe.error).toContain("simctl");
  });

  it("lists devices via `xcrun simctl list devices -j`", async () => {
    const { calls, run } = makeRun([
      { match: (_c, args) => args[0] === "simctl" && args[1] === "list", result: () => ({ code: 0, stdout: SIMCTL_LIST, stderr: "" }) },
    ]);
    const simctl = new Simctl({ run });
    const devices = await simctl.listDevices();
    expect(devices).toHaveLength(2);
    expect(calls[0]).toEqual({ cmd: "xcrun", args: ["simctl", "list", "devices", "-j"] });
  });

  it("screenshots via `io <udid> screenshot -` (PNG on stdout)", async () => {
    const binCalls: string[][] = [];
    const runBinary: RunBinaryFn = async (_cmd, args) => {
      binCalls.push([...args]);
      return { code: 0, stdout: pngBytes(10, 20), stderr: "" };
    };
    const simctl = new Simctl({ runBinary });
    const buf = await simctl.screenshot(UDID);
    expect(buf.length).toBeGreaterThan(8);
    expect(binCalls[0]).toEqual(["simctl", "io", UDID, "screenshot", "-"]);
  });

  it("falls back to a temp file when the '-' stdout form is unsupported", async () => {
    const binCalls: string[][] = [];
    const runBinary: RunBinaryFn = async (_cmd, args) => {
      binCalls.push([...args]);
      return { code: 1, stdout: Buffer.alloc(0), stderr: "screenshot: '-' unsupported on this Xcode" };
    };
    const readPaths: string[] = [];
    const rmPaths: string[] = [];
    const { calls, run } = makeRun([
      {
        match: (_c, args) => args[0] === "simctl" && args[1] === "io" && args[3] === "screenshot",
        result: () => ({ code: 0, stdout: "", stderr: "" }),
      },
    ]);
    const simctl = new Simctl({
      run,
      runBinary,
      readFile: (async (p: unknown) => {
        readPaths.push(String(p));
        return pngBytes(30, 40);
      }) as typeof import("node:fs/promises").readFile,
      rmFn: (async (p: unknown) => {
        rmPaths.push(String(p));
      }) as typeof import("node:fs/promises").rm,
    });
    const buf = await simctl.screenshot(UDID);
    expect(buf.length).toBeGreaterThan(8);
    expect(binCalls[0]).toEqual(["simctl", "io", UDID, "screenshot", "-"]);
    expect(calls[0]?.args[0]).toBe("simctl");
    expect(calls[0]?.args[1]).toBe("io");
    expect(calls[0]?.args[3]).toBe("screenshot");
    expect(String(calls[0]?.args[4])).toMatch(/\.png$/);
    expect(readPaths).toHaveLength(1);
    expect(rmPaths).toEqual(readPaths); // temp file cleaned up
  });

  it("runs launch/terminate/install/openurl with the expected simctl args", async () => {
    const { calls, run } = makeRun([{ match: (_c, args) => args[0] === "simctl" && ["launch", "terminate", "install", "openurl"].includes(args[1]), result: () => ({ code: 0, stdout: "ok", stderr: "" }) }]);
    const simctl = new Simctl({ run });
    await simctl.launchApp(UDID, "com.example.App", ["-arg1"]);
    await simctl.terminateApp(UDID, "com.example.App");
    await simctl.installApp(UDID, "/tmp/App.app");
    await simctl.openUrl(UDID, "https://example.com");
    expect(calls.map((c) => c.args)).toEqual([
      ["simctl", "launch", UDID, "com.example.App", "-arg1"],
      ["simctl", "terminate", UDID, "com.example.App"],
      ["simctl", "install", UDID, "/tmp/App.app"],
      ["simctl", "openurl", UDID, "https://example.com"],
    ]);
  });

  it("throws an honest error when launch fails (unknown bundle id)", async () => {
    const { run } = makeRun([{ match: (_c, a) => a[0] === "simctl" && a[1] === "launch", result: () => ({ code: 1, stdout: "", stderr: "Invalid bundle id" }) }]);
    const simctl = new Simctl({ run });
    await expect(simctl.launchApp(UDID, "no.such.app")).rejects.toMatchObject({ code: "element_not_found" });
  });

  it("parses listapps in both XML and OpenStep plist encodings", () => {
    for (const fixture of [LISTAPPS_XML, LISTAPPS_OPENSTEP]) {
      const apps = parseListapps(fixture);
      expect(apps).toEqual([
        { bundleId: "com.apple.Preferences", name: "Settings" },
        { bundleId: "com.example.App", name: "Example" },
      ]);
    }
  });
});

/* ------------------------------------------------------------------ */
/* idb                                                                 */
/* ------------------------------------------------------------------ */

describe("idb", () => {
  it("probe reports missing idb honestly", async () => {
    const { run } = makeRun([{ match: isWhichIdb, result: () => ({ code: 1, stdout: "", stderr: "" }) }]);
    expect(await probeIdb({ run })).toMatchObject({ ok: false });
  });

  it("probe finds idb via which", async () => {
    const { run } = makeRun([{ match: isWhichIdb, result: () => ({ code: 0, stdout: "/opt/homebrew/bin/idb\n", stderr: "" }) }]);
    expect(await probeIdb({ run })).toMatchObject({ ok: true, path: "/opt/homebrew/bin/idb" });
  });

  it("parses describe-all elements (AXLabel/type/AXFrame)", () => {
    const els = parseDescribeAll(IDB_DESCRIBE_ALL);
    expect(els).toHaveLength(5);
    expect(els[1]).toMatchObject({ role: "navbar", frame: { x: 0, y: 0, width: 375, height: 44 } });
    expect(els[2]).toMatchObject({ role: "text", label: "设置" });
    expect(els[3]).toMatchObject({ role: "button", label: "登录", identifier: "login-button", enabled: true });
  });

  it("rebuilt tree nests children by frame containment (DFS order)", () => {
    const tree = describeAllToTree(parseDescribeAll(IDB_DESCRIBE_ALL));
    expect(tree).not.toBeNull();
    expect(tree?.role).toBe("window");
    const kids = tree?.children ?? [];
    // Window → [NavigationBar[StaticText], Button, TextField]
    expect(kids.map((k) => k.role)).toEqual(["navbar", "button", "textfield"]);
    expect(kids[0]?.children?.[0]).toMatchObject({ role: "text", name: "设置" });
    expect(kids[1]).toMatchObject({ id: "ios:idb/3", clickable: true });
    expect(kids[2]).toMatchObject({ id: "ios:idb/4", editable: true });
  });

  it("parseIdbElement tolerates unknown frames and disabled elements", () => {
    const el = parseIdbElement({ type: "Button", AXLabel: "X", isEnabled: false });
    expect(el).toMatchObject({ role: "button", enabled: false });
    expect(el.frame).toBeUndefined();
  });

  it("parses `idb describe` screen_dimensions (points + scale)", () => {
    expect(parseIdbDescribe(IDB_DESCRIBE).screen).toEqual({ width: 375, height: 812, scale: 2 });
    expect(parseIdbDescribe("not json").screen).toBeUndefined();
  });

  it("CLI wrappers pass udid and coordinates", async () => {
    const { calls, run } = makeRun([{ match: (cmd) => cmd === "idb", result: () => ({ code: 0, stdout: "", stderr: "" }) }]);
    const idb = new Idb({ run });
    await idb.tap(UDID, 187.5, 22.2);
    await idb.text(UDID, "hello world");
    await idb.swipe(UDID, 187, 600, 187, 200, 300);
    expect(calls.map((c) => c.args)).toEqual([
      ["ui", "tap", "188", "22", "--udid", UDID],
      ["ui", "text", "hello world", "--udid", UDID],
      ["ui", "swipe", "187", "600", "187", "200", "--duration", "0.3", "--udid", UDID],
    ]);
  });

  it("describeAll goes through `idb ui describe-all --udid`", async () => {
    const { calls, run } = makeRun([
      { match: (cmd, args) => cmd === "idb" && args[0] === "describe", result: () => ({ code: 0, stdout: IDB_DESCRIBE, stderr: "" }) },
      { match: (cmd, args) => cmd === "idb" && args[0] === "ui" && args[1] === "describe-all", result: () => ({ code: 0, stdout: IDB_DESCRIBE_ALL, stderr: "" }) },
    ]);
    const idb = new Idb({ run });
    const tree = await idb.describeAllTree(UDID);
    expect(tree?.role).toBe("window");
    const metrics = await idb.describeDevice(UDID);
    expect(metrics.screen).toEqual({ width: 375, height: 812, scale: 2 });
    expect(calls[0]?.args).toEqual(["ui", "describe-all", "--udid", UDID]);
    expect(calls[1]?.args).toEqual(["describe", "--udid", UDID]);
  });
});

/* ------------------------------------------------------------------ */
/* WDA client                                                          */
/* ------------------------------------------------------------------ */

describe("wda client", () => {
  it("parses /status and honors base URL env chain", async () => {
    const { fetchFn } = makeFetch(wdaRoutes());
    const client = new WdaClient({ baseUrl: "http://localhost:8100/", fetchFn });
    const st = await client.status();
    expect(st).toMatchObject({ ready: true, state: "success", osName: "iOS", osVersion: "17.4" });
    expect(wdaBaseUrlFromEnv({} as NodeJS.ProcessEnv)).toBe("http://localhost:8100");
    expect(wdaBaseUrlFromEnv({ IOS_WDA_URL: "http://foo:9" } as NodeJS.ProcessEnv)).toBe("http://foo:9");
    expect(wdaBaseUrlFromEnv({ WDA_URL: "http://bar:8" } as NodeJS.ProcessEnv)).toBe("http://bar:8");
  });

  it("unreachable WDA → permission_required with setup hints (never silent)", async () => {
    const client = new WdaClient({ baseUrl: "http://localhost:8100", fetchFn: unreachableFetch });
    const err = await client.status().catch((e: ComputerUseError) => e);
    expect(err).toBeInstanceOf(ComputerUseError);
    expect(err.code).toBe("permission_required");
    expect(err.hint).toContain("Developer Mode");
    expect(err.hint).toContain("iproxy");
    expect(err.hint).toContain("Trust This Computer");
  });

  it("not-ready WDA → permission_required", async () => {
    const { fetchFn } = makeFetch([{ match: (m, p) => m === "GET" && p === "/status", respond: () => ({ ready: false, state: "building" }) }]);
    const client = new WdaClient({ baseUrl: "http://localhost:8100", fetchFn });
    await expect(client.assertReady()).rejects.toMatchObject({ code: "permission_required" });
  });

  it("creates a W3C session and reads the window size in points", async () => {
    const { calls, fetchFn } = makeFetch(wdaRoutes());
    const client = new WdaClient({ baseUrl: "http://localhost:8100", fetchFn });
    expect(await client.windowSize()).toEqual({ width: 375, height: 812 });
    const session = calls.find((c) => c.path === "/session");
    expect(session?.method).toBe("POST");
    expect((session?.body as { capabilities?: unknown }).capabilities).toBeDefined();
    expect(client.currentSessionId()).toBe(WDA_SID);
  });

  it("findElements returns W3C element ids; click/value/clear use element routes", async () => {
    const { calls, fetchFn } = makeFetch(wdaRoutes());
    const client = new WdaClient({ baseUrl: "http://localhost:8100", fetchFn });
    const ids = await client.findElements("accessibility id", "login-button");
    expect(ids).toEqual(["E-LOGIN"]);
    await client.clickElement("E-LOGIN");
    await client.elementValue("E-LOGIN", "hi");
    await client.elementClear("E-LOGIN");
    expect(calls.some((c) => c.path === `/session/${WDA_SID}/elements` && c.method === "POST" && (c.body as { using?: string })?.using === "accessibility id")).toBe(true);
    expect(calls.some((c) => c.path === `/session/${WDA_SID}/element/E-LOGIN/click`)).toBe(true);
    expect(calls.some((c) => c.path === `/session/${WDA_SID}/element/E-LOGIN/value` && JSON.stringify(c.body).includes('"h"'))).toBe(true);
    expect(calls.some((c) => c.path === `/session/${WDA_SID}/element/E-LOGIN/clear`)).toBe(true);
  });

  it("coordinate ops hit the /wda endpoints", async () => {
    const { calls, fetchFn } = makeFetch(wdaRoutes());
    const client = new WdaClient({ baseUrl: "http://localhost:8100", fetchFn });
    await client.tap(10, 20);
    await client.doubleTap(10, 20);
    await client.touchAndHold(10, 20, 0.9);
    await client.drag(0, 500, 0, 100, 0.3);
    await client.pressHome();
    await client.typeText("abc");
    await client.keys("\n");
    const paths = calls.map((c) => `${c.method} ${c.path}`);
    expect(paths).toContain(`POST /session/${WDA_SID}/wda/tap/0`);
    expect(paths).toContain(`POST /session/${WDA_SID}/wda/doubleTap`);
    expect(paths).toContain(`POST /session/${WDA_SID}/wda/touchAndHold`);
    expect(paths).toContain(`POST /session/${WDA_SID}/wda/dragfromtoforduration`);
    expect(paths).toContain(`POST /session/${WDA_SID}/wda/pressHome`);
    expect(paths).toContain(`POST /session/${WDA_SID}/wda/type`);
    expect(paths).toContain(`POST /session/${WDA_SID}/wda/keys`);
  });

  it("screenshot decodes base64 PNG from /screenshot", async () => {
    const { fetchFn } = makeFetch(wdaRoutes());
    const client = new WdaClient({ baseUrl: "http://localhost:8100", fetchFn });
    const buf = await client.screenshot();
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
  });

  it("maps HTTP errors to honest ComputerUseErrors", async () => {
    const { fetchFn } = makeFetch([]);
    const client = new WdaClient({ baseUrl: "http://localhost:8100", fetchFn });
    const err = await client.status().catch((e: ComputerUseError) => e);
    expect(err.code).toBe("provider_error");
    expect(err.message).toContain("no route for /status");
  });

  it("times out via AbortController with code=timeout", async () => {
    const never: FetchFn = (_url, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("The operation was aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    const client = new WdaClient({ baseUrl: "http://localhost:8100", fetchFn: never, timeoutMs: 50 });
    await expect(client.status()).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("wda source parsing", () => {
  it("handles CGRect-string and object frames, normalizes XCUIElementType roles", () => {
    const root = parseWdaSource(WDA_SOURCE);
    expect(root).not.toBeNull();
    expect(root).toMatchObject({ role: "application", label: "Settings", frame: { x: 0, y: 0, width: 375, height: 812 } });
    const win = root!.children[0]!;
    expect(win.role).toBe("window");
    const [login, search, text] = win.children;
    expect(login).toMatchObject({ role: "button", label: "登录", identifier: "login-button", frame: { x: 40, y: 600, width: 295, height: 44 } });
    expect(search).toMatchObject({ role: "textfield", identifier: "search-field", frame: { x: 20, y: 100, width: 335, height: 36 } });
    expect(text?.role).toBe("text");
  });

  it("returns null for non-object values", () => {
    expect(parseWdaSource(null)).toBeNull();
    expect(parseWdaSource("x")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Adapter — capability matrix decisions                               */
/* ------------------------------------------------------------------ */

function simctlHandlers(opts: { idb: boolean } = { idb: false }): RunHandler[] {
  return [
    { match: isXcrunFind, result: () => ({ code: 0, stdout: "/usr/bin/simctl", stderr: "" }) },
    { match: (_c, args) => args[0] === "simctl" && args[1] === "list", result: () => ({ code: 0, stdout: SIMCTL_LIST, stderr: "" }) },
    { match: isWhichIdb, result: () => (opts.idb ? { code: 0, stdout: "/opt/homebrew/bin/idb", stderr: "" } : { code: 1, stdout: "", stderr: "not found" }) },
    { match: (_c, args) => args[0] === "describe" && args[1] === "--udid", result: () => ({ code: 0, stdout: IDB_DESCRIBE, stderr: "" }) },
    { match: (_c, args) => args[0] === "ui" && args[1] === "describe-all", result: () => ({ code: 0, stdout: IDB_DESCRIBE_ALL, stderr: "" }) },
    { match: (_c, args) => args[0] === "ui", result: () => ({ code: 0, stdout: "", stderr: "" }) },
    { match: (_c, args) => args[0] === "simctl" && args[1] === "listapps", result: () => ({ code: 0, stdout: LISTAPPS_XML, stderr: "" }) },
    { match: (_c, args) => args[0] === "simctl" && ["launch", "terminate", "install", "openurl"].includes(args[1]), result: () => ({ code: 0, stdout: "ok", stderr: "" }) },
    { match: (_c, args) => args[0] === "simctl" && args[1] === "io", result: () => ({ code: 0, stdout: "", stderr: "" }) },
  ];
}

const SIM_PNG = () => pngBytes(750, 1624); // 375x812 logical @2x

describe("IosAdapter capability matrix", () => {
  it("simulator + simctl + idb (no WDA): full sim experience, scale from idb", async () => {
    const { run } = makeRun(simctlHandlers({ idb: true }));
    const binCalls: string[][] = [];
    const adapter = new IosAdapter({
      target: { type: "simulator", platform: "ios" },
      run,
      runBinary: async (_c, args) => {
        binCalls.push([...args]);
        return { code: 0, stdout: SIM_PNG(), stderr: "" };
      },
      fetchFn: unreachableFetch,
    });
    const info = await adapter.open();
    expect(info).toMatchObject({ platform: "ios", type: "simulator", deviceId: UDID });
    expect(info.details).toMatchObject({ kind: "simulator" });

    const caps = adapter.getCapabilities();
    expect(caps.screenshot).toBe(true);
    expect(caps.accessibility).toBe(true);
    expect(caps.globalInput).toBe(true);
    expect(caps.appControl).toBe(true);
    expect(caps.windowControl).toBe(false);
    expect(caps.dom).toBe(false);
    expect(caps.clipboard).toBe(false);
    expect(caps.multiDisplay).toBe(false);
    expect(caps.notes.join("\n")).not.toContain("install idb"); // idb present

    const screen = await adapter.getScreenInfo();
    expect(screen).toMatchObject({ width: 375, height: 812, orientation: "portrait" });
    expect(screen.displays[0]).toMatchObject({ scale: 2 });

    const shot = await adapter.screenshot();
    expect(shot.scale).toBe(2);
    expect(shot.width).toBe(750);
    expect(shot.height).toBe(1624);
    expect(binCalls[0]).toEqual(["simctl", "io", UDID, "screenshot", "-"]);
  });

  it("simulator simctl-only (no idb, no WDA): vision-only, honest notes, no input", async () => {
    const { run } = makeRun(simctlHandlers({ idb: false }));
    const adapter = new IosAdapter({
      target: { type: "simulator", platform: "ios" },
      run,
      runBinary: async () => ({ code: 0, stdout: SIM_PNG(), stderr: "" }),
      fetchFn: unreachableFetch,
    });
    await adapter.open();
    const caps = adapter.getCapabilities();
    expect(caps.screenshot).toBe(true);
    expect(caps.accessibility).toBe(false);
    expect(caps.globalInput).toBe(false);
    expect(caps.appControl).toBe(true);
    const notes = caps.notes?.join("\n") ?? "";
    expect(notes).toContain("install idb: brew install idb-companion; pip install fb-idb");
    expect(notes).toContain("scale is assumed 1");

    expect(await adapter.locate({ name: "登录" })).toBeNull(); // vision-only

    const click = await adapter.executeAction({ type: "click", point: { x: 100, y: 100, space: "screenshot" } });
    expect(click.ok).toBe(false);
    expect(click.error?.code).toBe("permission_required");

    const tree = await adapter.refreshTree();
    expect(tree).toBeNull();
  });

  it("real device + WDA reachable: everything available, scale derived from px/logical", async () => {
    const { calls, fetchFn } = makeFetch(wdaRoutes());
    const adapter = new IosAdapter({
      target: { type: "device", platform: "ios", deviceId: "00008101-000A" },
      fetchFn,
    });
    const info = await adapter.open();
    expect(info).toMatchObject({ platform: "ios", type: "device", deviceId: "00008101-000A" });
    expect(info.details).toMatchObject({ kind: "device", wda: { ready: true } });

    const caps = adapter.getCapabilities();
    expect(caps.screenshot).toBe(true);
    expect(caps.accessibility).toBe(true);
    expect(caps.globalInput).toBe(true);
    expect(caps.appControl).toBe(true);
    expect(caps.windowControl).toBe(false);

    const shot = await adapter.screenshot();
    expect(shot.scale).toBe(2); // 1624 px / 812 pt
    expect(shot.orientation).toBe("portrait");

    const obs = await adapter.observe({ includeScreenshot: false });
    expect(obs.uiTree?.role).toBe("application");
    expect(obs.activeApp).toMatchObject({ name: "Settings", identifier: "com.apple.Preferences" });
    expect(calls.some((c) => c.path.endsWith("/wda/activeAppInfo"))).toBe(true);
  });

  it("real device, WDA unreachable: caps all false, permission_required with hints", async () => {
    const adapter = new IosAdapter({
      target: { type: "device", platform: "ios", deviceId: "00008101-000A" },
      fetchFn: unreachableFetch,
    });
    await adapter.open();
    const caps = adapter.getCapabilities();
    expect(caps.screenshot).toBe(false);
    expect(caps.accessibility).toBe(false);
    expect(caps.globalInput).toBe(false);
    expect(caps.appControl).toBe(false);
    const notes = caps.notes?.join("\n") ?? "";
    expect(notes).toContain("Developer Mode");
    expect(notes).toContain("iproxy");

    await expect(adapter.screenshot()).rejects.toMatchObject({ code: "permission_required" });
    const click = await adapter.executeAction({ type: "click", point: { x: 5, y: 5 } });
    expect(click.ok).toBe(false);
    expect(click.error?.code).toBe("permission_required");
    expect(click.error?.hint).toContain("Trust This Computer");
  });

  it("rejects invalid target shapes at construction/open", async () => {
    expect(() => new IosAdapter({ target: { type: "local", platform: "ios" }, fetchFn: unreachableFetch })).toThrowError(
      expect.objectContaining({ code: "invalid_request" }),
    );
    const adapter = new IosAdapter({ target: { type: "device", platform: "ios" }, fetchFn: unreachableFetch });
    await expect(adapter.open()).rejects.toMatchObject({ code: "invalid_request" });
    const adapter2 = new IosAdapter({ target: { type: "simulator", platform: "ios", deviceId: "GHOST" }, fetchFn: unreachableFetch, run: makeRun(simctlHandlers({ idb: false })).run });
    await expect(adapter2.open()).rejects.toMatchObject({ code: "device_not_found" });
  });
});

/* ------------------------------------------------------------------ */
/* Adapter — tree, locate, actions                                     */
/* ------------------------------------------------------------------ */

describe("IosAdapter trees/locate/actions (simulator via idb)", () => {
  it("observe builds the idb tree; locate by label and accessibility id; tap by center", async () => {
    const { calls, run } = makeRun(simctlHandlers({ idb: true }));
    const adapter = new IosAdapter({
      target: { type: "simulator", platform: "ios" },
      run,
      runBinary: async () => ({ code: 0, stdout: SIM_PNG(), stderr: "" }),
      fetchFn: unreachableFetch,
    });
    await adapter.open();

    const obs = await adapter.observe({ includeScreenshot: false });
    expect(obs.uiTree?.role).toBe("window");
    expect(obs.activeApp).toBeUndefined(); // no WDA → honest: no active-app info

    const byLabel = await adapter.locate({ name: "登录" });
    expect(byLabel).toMatchObject({ element: { role: "button", name: "登录" } });
    expect(byLabel?.element.attributes).toMatchObject({ identifier: "login-button", boundsSpace: "logical" });

    const byId = await adapter.locate({ resourceId: "search-field" });
    expect(byId?.element).toMatchObject({ role: "textfield", editable: true });

    const byRole = await adapter.locate({ role: "text", name: "设置" });
    expect(byRole?.element).toMatchObject({ role: "text", name: "设置" });

    // click located element → idb tap at its center (bounds are logical pts)
    const result = await adapter.executeAction({ type: "click", element: byLabel!.element });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("coordinate"); // idb has no semantic handles
    const tap = calls.find((c) => c.args[0] === "ui" && c.args[1] === "tap");
    expect(tap?.args).toEqual(["ui", "tap", "188", "622", "--udid", UDID]); // center of 40,600,295x44

    // type without element → keyboard text
    const typed = await adapter.executeAction({ type: "type", text: "hello" });
    expect(typed.ok).toBe(true);
    expect(calls.some((c) => c.args[1] === "text" && c.args[2] === "hello")).toBe(true);

    // swipe via idb
    const swiped = await adapter.executeAction({
      type: "swipe",
      from: { point: { x: 187, y: 600, space: "logical" } },
      to: { point: { x: 187, y: 200, space: "logical" } },
    });
    expect(swiped.ok).toBe(true);
    expect(calls.some((c) => c.args[1] === "swipe")).toBe(true);

    // back/home unsupported without WDA — honest errors
    expect((await adapter.executeAction({ type: "back" })).error?.code).toBe("unsupported");
    expect((await adapter.executeAction({ type: "home" })).error?.code).toBe("unsupported");
    expect((await adapter.executeAction({ type: "hotkey", keys: ["cmd", "q"] })).error?.code).toBe("unsupported");
  });

  it("appControl via simctl: launch/terminate/listapps, focus via relaunch", async () => {
    const { calls, run } = makeRun(simctlHandlers({ idb: false }));
    const adapter = new IosAdapter({
      target: { type: "simulator", platform: "ios" },
      run,
      runBinary: async () => ({ code: 0, stdout: SIM_PNG(), stderr: "" }),
      fetchFn: unreachableFetch,
    });
    await adapter.open();

    await adapter.launchApp("com.apple.Preferences");
    await adapter.terminateApp("com.apple.Preferences");
    await adapter.focusTarget({ app: "com.apple.Preferences" });
    expect(calls.filter((c) => c.args[1] === "launch").map((c) => c.args.slice(1, 4))).toEqual([
      ["launch", UDID, "com.apple.Preferences"],
      ["launch", UDID, "com.apple.Preferences"], // focus = relaunch/activate
    ]);
    expect(calls.some((c) => c.args[1] === "terminate" && c.args[3] === "com.apple.Preferences")).toBe(true);

    const apps = await adapter.listApps();
    expect(apps).toContainEqual({ name: "Settings", identifier: "com.apple.Preferences" });
    expect(apps).toContainEqual({ name: "Example", identifier: "com.example.App" });
  });

  it("installApp/openUrl run on simulators; windowTitle focus is unsupported", async () => {
    const { calls, run } = makeRun(simctlHandlers({ idb: false }));
    const adapter = new IosAdapter({
      target: { type: "simulator", platform: "ios" },
      run,
      runBinary: async () => ({ code: 0, stdout: SIM_PNG(), stderr: "" }),
      fetchFn: unreachableFetch,
    });
    await adapter.open();
    await adapter.installApp("/tmp/App.app");
    await adapter.openUrl("myapp://deep/link");
    expect(calls.some((c) => c.args[1] === "install")).toBe(true);
    expect(calls.some((c) => c.args[1] === "openurl")).toBe(true);
    await expect(adapter.focusTarget({ windowTitle: "Main" })).rejects.toMatchObject({ code: "unsupported" });
    expect(await adapter.listWindows()).toEqual([]);
  });
});

describe("IosAdapter actions (device via WDA)", () => {
  function deviceAdapter() {
    const { calls, fetchFn } = makeFetch(wdaRoutes());
    const adapter = new IosAdapter({
      target: { type: "device", platform: "ios", deviceId: "00008101-000A" },
      fetchFn,
    });
    return { calls, adapter };
  }

  it("click on a located element → semantic WDA element click", async () => {
    const { calls, adapter } = deviceAdapter();
    await adapter.open();
    const found = await adapter.locate({ name: "登录" });
    expect(found).not.toBeNull();
    const r = await adapter.executeAction({ type: "click", element: found!.element });
    expect(r.ok).toBe(true);
    expect(r.method).toBe("semantic");
    expect(calls.some((c) => c.path === `/session/${WDA_SID}/elements` && (c.body as { value?: string })?.value === "login-button")).toBe(true);
    expect(calls.some((c) => c.path === `/session/${WDA_SID}/element/E-LOGIN/click`)).toBe(true);
  });

  it("type into a located field → element/value with char array; submit appends newline", async () => {
    const { calls, adapter } = deviceAdapter();
    await adapter.open();
    const found = await adapter.locate({ resourceId: "search-field" });
    const r = await adapter.executeAction({ type: "type", text: "hi", element: found!.element, submit: true });
    expect(r.ok).toBe(true);
    expect(r.method).toBe("semantic");
    const valueCall = calls.find((c) => c.path === `/session/${WDA_SID}/element/E-SEARCH/value`);
    expect((valueCall?.body as { value?: string[] })?.value).toEqual(["h", "i", "\n"]);
  });

  it("set_value clears then types; home → pressHome; scroll → drag with correct direction", async () => {
    const { calls, adapter } = deviceAdapter();
    await adapter.open();
    const found = await adapter.locate({ resourceId: "search-field" });

    expect((await adapter.executeAction({ type: "set_value", element: found!.element, value: "abc" })).ok).toBe(true);
    expect(calls.some((c) => c.path === `/session/${WDA_SID}/element/E-SEARCH/clear`)).toBe(true);

    expect((await adapter.executeAction({ type: "home" })).ok).toBe(true);
    expect(calls.some((c) => c.path === `/session/${WDA_SID}/wda/pressHome`)).toBe(true);

    const scroll = await adapter.executeAction({ type: "scroll", direction: "down" });
    expect(scroll.ok).toBe(true);
    const drag = calls.find((c) => c.path === `/session/${WDA_SID}/wda/dragfromtoforduration`);
    const body = drag?.body as { fromX: number; fromY: number; toX: number; toY: number };
    // 375x812 points, center (187.5, 406), fraction 0.2 → swipe UP for scroll-down
    expect(body.fromX).toBeCloseTo(187.5, 5);
    expect(body.fromY).toBeCloseTo(568.4, 5);
    expect(body.toY).toBeCloseTo(243.6, 5);
    expect(body.fromY).toBeGreaterThan(body.toY);
  });

  it("coordinate tap converts screenshot px → logical points via scale", async () => {
    const { calls, adapter } = deviceAdapter();
    await adapter.open();
    await adapter.screenshot(); // establishes scale=2
    const r = await adapter.executeAction({ type: "click", point: { x: 100, y: 200, space: "screenshot" } });
    expect(r.ok).toBe(true);
    const tap = calls.find((c) => c.path === `/session/${WDA_SID}/wda/tap/0`);
    expect((tap?.body as { x: number; y: number })).toEqual({ x: 50, y: 100 });
  });

  it("honors normalized [0,1000] and physical spaces", async () => {
    const { calls, adapter } = deviceAdapter();
    await adapter.open();
    await adapter.executeAction({ type: "click", point: { x: 500, y: 500, space: "normalized" } });
    let tap = calls.find((c) => c.path === `/session/${WDA_SID}/wda/tap/0`);
    expect((tap?.body as { x: number; y: number })).toEqual({ x: 187.5, y: 406 });
    await adapter.screenshot(); // scale 2
    await adapter.executeAction({ type: "click", point: { x: 200, y: 400, space: "physical" } });
    tap = calls.filter((c) => c.path === `/session/${WDA_SID}/wda/tap/0`).at(-1);
    expect((tap?.body as { x: number; y: number })).toEqual({ x: 100, y: 200 });
  });

  it("press/hotkey/back/right_click/move honestly unsupported or mapped", async () => {
    const { calls, adapter } = deviceAdapter();
    await adapter.open();
    expect((await adapter.executeAction({ type: "back" })).error?.code).toBe("unsupported");
    expect((await adapter.executeAction({ type: "right_click", point: { x: 1, y: 1 } })).error?.code).toBe("unsupported");
    expect((await adapter.executeAction({ type: "move", point: { x: 1, y: 1 } })).error?.code).toBe("unsupported");
    expect((await adapter.executeAction({ type: "hotkey", keys: ["ctrl", "c"] })).error?.code).toBe("unsupported");
    expect((await adapter.executeAction({ type: "press", key: "F5" })).error?.code).toBe("unsupported");
    expect((await adapter.executeAction({ type: "press", key: "enter" })).ok).toBe(true);
    expect(calls.some((c) => c.path === `/session/${WDA_SID}/wda/keys` && JSON.stringify(c.body) === JSON.stringify({ value: ["\n"] }))).toBe(true);
  });

  it("app launch/activate/list via WDA", async () => {
    const { calls, adapter } = deviceAdapter();
    await adapter.open();
    await adapter.launchApp("com.example.App");
    await adapter.focusTarget({ app: "com.example.App" });
    expect(calls.some((c) => c.path === `/session/${WDA_SID}/wda/apps/launch` && (c.body as { bundleId?: string })?.bundleId === "com.example.App")).toBe(true);
    expect(calls.some((c) => c.path === `/session/${WDA_SID}/wda/apps/activate`)).toBe(true);

    const { fetchFn } = makeFetch([
      ...wdaRoutes().filter((r) => !r.match("GET", `/session/${WDA_SID}/wda/apps/list`)),
      {
        match: (m, p) => m === "GET" && p === `/session/${WDA_SID}/wda/apps/list`,
        respond: () => ({
          "com.example.App": { bundleDisplayName: "Example", bundleName: "Example" },
          "com.apple.Preferences": { bundleName: "Settings" },
        }),
      },
    ]);
    const adapter2 = new IosAdapter({ target: { type: "device", platform: "ios", deviceId: "D" }, fetchFn });
    await adapter2.open();
    const apps = await adapter2.listApps();
    // frontmost flag comes from /wda/activeAppInfo → com.apple.Preferences
    expect(apps).toContainEqual({ name: "Settings", identifier: "com.apple.Preferences", frontmost: true });
    expect(apps).toContainEqual({ name: "Example", identifier: "com.example.App" });
  });

  it("wait/finish/fail behave like the reference adapters", async () => {
    const { adapter } = deviceAdapter();
    await adapter.open();
    expect((await adapter.executeAction({ type: "wait", durationMs: 1 })).ok).toBe(true);
    expect((await adapter.executeAction({ type: "finish", status: "success" })).detail).toBe("finish");
    expect((await adapter.executeAction({ type: "fail", reason: "nope" })).detail).toBe("fail");
  });
});

/* ------------------------------------------------------------------ */
/* iosProbe                                                            */
/* ------------------------------------------------------------------ */

describe("iosProbe", () => {
  it("unavailable when simctl is missing, no idb, WDA down", async () => {
    const { run } = makeRun([
      { match: isXcrunFind, result: () => ({ code: 69, stdout: "", stderr: "unable to find utility" }) },
      { match: isWhichIdb, result: () => ({ code: 1, stdout: "", stderr: "" }) },
    ]);
    const probe = await iosProbe({ run, fetchFn: unreachableFetch });
    expect(probe.available).toBe(false);
    expect(probe.reason).toContain("No iOS target");
    expect(probe.details).toMatchObject({ simctl: { ok: false }, idb: { ok: false }, wda: { ok: false } });
  });

  it("available when simctl works and simulators exist; lists booted UDIDs", async () => {
    const { run } = makeRun(simctlHandlers({ idb: false }));
    const probe = await iosProbe({ run, fetchFn: unreachableFetch });
    expect(probe.available).toBe(true);
    expect(probe.details).toMatchObject({ simulators: 2, booted: [UDID] });
  });

  it("available when only WDA is reachable (real-device automation)", async () => {
    const { run } = makeRun([
      { match: isXcrunFind, result: () => ({ code: 69, stdout: "", stderr: "no xcode" }) },
      { match: isWhichIdb, result: () => ({ code: 1, stdout: "", stderr: "" }) },
    ]);
    const { fetchFn } = makeFetch(wdaRoutes());
    const probe = await iosProbe({ run, fetchFn });
    expect(probe.available).toBe(true);
    expect(probe.details).toMatchObject({ wda: { ok: true, url: "http://localhost:8100" } });
  });

  it("never throws (probe contract)", async () => {
    const exploding: RunFn = async () => {
      throw new Error("boom");
    };
    const probe = await iosProbe({ run: exploding, fetchFn: unreachableFetch });
    expect(probe.available).toBe(false);
  });
});
