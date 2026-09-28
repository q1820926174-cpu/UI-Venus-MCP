/**
 * RemoteWindowsAdapter unit tests: bridge protocol against an injected
 * fake ssh/scp exec (no real network). Verifies enqueue/poll parsing,
 * EncodedCommand hygiene, capture fetch, action mapping, error taxonomy.
 */
import { describe, expect, it, vi } from "vitest";
import { RemoteWindowsAdapter, type ExecFn } from "../../src/platforms/windows/remote-ssh.js";
import { ComputerUseError } from "../../src/core/errors.js";

interface Call {
  cmd: string;
  args: string[];
}

function fakeExec(handlers: {
  onCommand?: (id: string) => string; // result JSON for the poll
  png?: Buffer;
  calls?: Call[];
}): ExecFn {
  return async (cmd, args) => {
    handlers.calls?.push({ cmd, args });
    if (cmd === "ssh") {
      const remote = args[args.length - 1]!;
      if (remote.includes("EncodedCommand")) {
        return { stdout: "", stderr: "" };
      }
      // poll: extract the result file path and serve the handler's JSON
      const m = remote.match(/'([^']+results\\[^']+\.json)'/);
      if (m && handlers.onCommand) {
        const id = m[1]!.match(/results\\(.+?)\.json/)![1]!;
        return { stdout: handlers.onCommand(id), stderr: "" };
      }
      return { stdout: "PENDING", stderr: "" };
    }
    if (cmd === "scp") {
      if (handlers.png && args.some((a) => a.endsWith("shot.png"))) {
        const { writeFileSync } = require("node:fs") as typeof import("node:fs");
        const local = args[args.length - 1]!;
        writeFileSync(local, handlers.png);
      }
      return { stdout: "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
}

function resultJson(id: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({ id, ok: true, exit: 0, json: null, stdout: "", stderr: "", at: "t", ...over });
}

const png1x1 = (() => {
  // 128×128 noise: big enough to pass the capture probe threshold
  const { PNG } = require("pngjs") as typeof import("pngjs");
  const png = new PNG({ width: 128, height: 128 });
  for (let i = 0; i < png.data.length; i++) png.data[i] = (i * 31 + 7) % 256;
  return PNG.sync.write(png);
})();

describe("RemoteWindowsAdapter (bridge protocol)", () => {
  it("open() probes ping/sysinfo/capture and reports capabilities", async () => {
    const calls: Call[] = [];
    let n = 0; // 1st command = ping, 2nd = sysinfo, 3rd = capture probe
    const adapter = new RemoteWindowsAdapter({
      sshHost: "testhost",
      remoteRoot: "C:\\r",
      exec: fakeExec({
        calls,
        onCommand: (id) => {
          n += 1;
          if (n === 2) return resultJson(id, { stdout: JSON.stringify({ virtualScreen: { x: 0, y: 0, width: 1920, height: 1080 } }) });
          return resultJson(id, { stdout: JSON.stringify({ ok: true, width: 1920, height: 1080 }) });
        },
        png: png1x1,
      }),
    });
    const info = await adapter.open();
    expect(info.platform).toBe("windows");
    expect(info.type).toBe("remote");
    const caps = adapter.getCapabilities();
    expect(caps.screenshot).toBe(true);
    expect(caps.notes?.join(" ")).toContain("queue bridge");
  });

  it("screenshot() fetches the PNG via scp and builds a Screenshot", async () => {
    const adapter = new RemoteWindowsAdapter({
      sshHost: "h",
      remoteRoot: "C:\\r",
      exec: fakeExec({ onCommand: (id) => resultJson(id, { stdout: '{"ok":true}' }), png: png1x1 }),
    });
    await adapter.open().catch(() => {});
    const shot = await adapter.screenshot();
    expect(shot.width).toBe(128);
    expect(shot.height).toBe(128);
    expect(shot.scale).toBe(1);
    expect(shot.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("click maps to input op with physical pixel rounding", async () => {
    let seen: Record<string, unknown> | undefined;
    const adapter = new RemoteWindowsAdapter({
      sshHost: "h",
      remoteRoot: "C:\\r",
      exec: async (cmd, args) => {
        if (cmd === "ssh" && args[args.length - 1]!.includes("EncodedCommand")) {
          // decode the b64 payload embedded in the PS snippet
          const enc = args[args.length - 1]!.split(" ").pop()!;
          const ps = Buffer.from(enc, "base64").toString("utf16le");
          const b64m = ps.match(/FromBase64String\('([^']+)'/);
          if (b64m) seen = JSON.parse(Buffer.from(b64m[1]!, "base64").toString("utf8"));
          return { stdout: "", stderr: "" };
        }
        return { stdout: resultJson("x"), stderr: "" };
      },
    });
    await adapter.open().catch(() => {});
    const r = await adapter.executeAction({ type: "click", point: { x: 1242.7, y: 480.2, space: "screenshot" } });
    expect(r.ok).toBe(true);
    expect(r.method).toBe("coordinate");
    expect(r.point).toEqual({ x: 1243, y: 480 });
    expect(seen?.op).toBe("input");
    expect(seen?.mode).toBe("click");
    expect(seen?.args).toMatchObject({ x: 1243, y: 480, button: "left", clicks: 1 });
  });

  it("rejects non-screenshot coordinate spaces honestly", async () => {
    const adapter = new RemoteWindowsAdapter({ sshHost: "h", remoteRoot: "C:\\r", exec: fakeExec({ onCommand: (id) => resultJson(id) }) });
    await adapter.open().catch(() => {});
    const r = await adapter.executeAction({ type: "click", point: { x: 1, y: 1, space: "normalized" } });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("screenshot/physical");
  });

  it("maps bridge failures to honest error codes", async () => {
    const adapter = new RemoteWindowsAdapter({
      sshHost: "h",
      remoteRoot: "C:\\r",
      exec: fakeExec({ onCommand: (id) => resultJson(id, { ok: false, exit: 6, stderr: "INPUT_FAILED: injected 0 (Win32Error=5)" }) }),
    });
    await adapter.open().catch(() => {});
    const r = await adapter.executeAction({ type: "click", point: { x: 5, y: 5, space: "screenshot" } });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("restricted");
  });

  it("open() surfaces device_offline when the bridge never answers", async () => {
    const adapter = new RemoteWindowsAdapter({
      sshHost: "h",
      remoteRoot: "C:\\r",
      exec: async (_cmd, _args) => ({ stdout: "PENDING", stderr: "" }),
    });
    // shrink the deadline by racing open() against rejection
    await expect(adapter.open()).rejects.toThrow(/bridge unreachable|timed out/);
  });

  it("unsupported semantic actions report unsupported (coordinate-driven executor)", async () => {
    const adapter = new RemoteWindowsAdapter({ sshHost: "h", remoteRoot: "C:\\r", exec: fakeExec({ onCommand: (id) => resultJson(id) }) });
    await adapter.open().catch(() => {});
    const r = await adapter.executeAction({ type: "set_value", element: { id: "x", source: "uia" }, value: "v" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("unsupported");
  });

  it("EncodedCommand payload is UTF-16LE base64 (powershell contract)", async () => {
    let enc = "";
    const adapter = new RemoteWindowsAdapter({
      sshHost: "h",
      remoteRoot: "C:\\r",
      exec: async (cmd, args) => {
        if (cmd === "ssh") {
          const remote = args[args.length - 1]!;
          if (remote.includes("EncodedCommand")) {
            enc = remote.split(" ").pop()!;
            return { stdout: "", stderr: "" };
          }
          return { stdout: resultJson("x"), stderr: "" };
        }
        return { stdout: "", stderr: "" };
      },
    });
    await adapter.open().catch(() => {});
    expect(enc).not.toBe("");
    const decoded = Buffer.from(enc, "base64").toString("utf16le");
    expect(decoded).toContain("Set-Content");
    expect(decoded).toContain("FromBase64String");
  });
});

void ComputerUseError;
void vi;
