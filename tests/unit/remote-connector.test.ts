/**
 * Remote-target registry + SshQueueConnector protocol tests (hermetic:
 * injected fake exec; no real network).
 */
import { describe, expect, it } from "vitest";
import { parseRemotes } from "../../src/remote/registry.js";
import { SshQueueConnector } from "../../src/remote/ssh-queue.js";
import { ComputerUseError } from "../../src/core/errors.js";

describe("parseRemotes (CUMCP_REMOTES)", () => {
  it("parses a list of named remotes", () => {
    const remotes = parseRemotes({
      CUMCP_REMOTES: JSON.stringify([
        { name: "win-151", platform: "windows", kind: "ssh-queue", sshHost: "goldagent-151", root: "C:\\Users\\gold\\win-remote" },
        { name: "win-lab2", platform: "windows", sshHost: "lab2", root: "C:\\lab" },
      ]),
    });
    expect(remotes).toHaveLength(2);
    expect(remotes[0]).toMatchObject({ name: "win-151", platform: "windows", kind: "ssh-queue", sshHost: "goldagent-151" });
    expect(remotes[1]!.kind).toBe("ssh-queue"); // default kind
  });

  it("accepts a single object (not wrapped in a list)", () => {
    const remotes = parseRemotes({
      CUMCP_REMOTES: JSON.stringify({ name: "solo", platform: "windows", sshHost: "h", root: "C:\\r" }),
    });
    expect(remotes).toHaveLength(1);
    expect(remotes[0]!.name).toBe("solo");
  });

  it("supports host= alias and remoteRoot fallback", () => {
    const remotes = parseRemotes({
      CUMCP_REMOTES: JSON.stringify({ name: "x", platform: "windows", host: "h1", remoteRoot: "C:\\a" }),
    });
    expect(remotes[0]).toMatchObject({ sshHost: "h1", root: "C:\\a" });
  });

  it("rejects invalid JSON with an actionable error", () => {
    expect(() => parseRemotes({ CUMCP_REMOTES: "{nope" })).toThrow(ComputerUseError);
  });

  it("rejects unknown platforms and connector kinds", () => {
    expect(() => parseRemotes({ CUMCP_REMOTES: JSON.stringify({ platform: "android", sshHost: "h", root: "r" }) })).toThrow(/platform/);
    expect(() => parseRemotes({ CUMCP_REMOTES: JSON.stringify({ platform: "windows", kind: "rdp", sshHost: "h", root: "r" }) })).toThrow(/kind/);
  });

  it("keeps the single-target shorthand and de-duplicates against the list", () => {
    const remotes = parseRemotes({
      CUMCP_REMOTES: JSON.stringify([{ name: "a", platform: "windows", sshHost: "dup", root: "r" }]),
      CUMCP_REMOTE_WINDOWS_SSH: "dup",
      CUMCP_REMOTE_WINDOWS_ROOT: "C:\\other",
    });
    expect(remotes).toHaveLength(1);
    const single = parseRemotes({ CUMCP_REMOTE_WINDOWS_SSH: "solo-host" });
    expect(single).toHaveLength(1);
    expect(single[0]).toMatchObject({ platform: "windows", sshHost: "solo-host", root: "C:\\Users\\gold\\win-remote" });
  });

  it("returns empty without configuration", () => {
    expect(parseRemotes({})).toEqual([]);
  });
});

describe("SshQueueConnector (protocol)", () => {
  function fakeConn(onCommand: (id: string, op: string, extra: Record<string, unknown>) => Record<string, unknown> | "PENDING") {
    return new SshQueueConnector({
      sshHost: "h",
      remoteRoot: "C:\\r",
      pollIntervalMs: 1,
      exec: async (cmd, args) => {
        if (cmd === "ssh") {
          const remote = args[args.length - 1]!;
          if (remote.includes("EncodedCommand")) {
            const enc = remote.split(" ").pop()!;
            const ps = Buffer.from(enc, "base64").toString("utf16le");
            void ps;
            return { stdout: "", stderr: "" };
          }
          const m = remote.match(/results\\(.+?)\.json/);
          if (m) {
            const id = m[1]!;
            const res = onCommand(id, "x", {});
            if (res === "PENDING") return { stdout: "PENDING", stderr: "" };
            return { stdout: JSON.stringify(res), stderr: "" };
          }
          return { stdout: "PENDING", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      },
    });
  }

  it("round-trips a command through the queue with a real BridgeResult", async () => {
    const c = fakeConn((id) => ({ id, ok: true, exit: 0, json: null, stdout: "OK", stderr: "", at: "t" }));
    const r = await c.command("ping");
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe("OK");
  });

  it("maps bridge failures to honest error codes", async () => {
    const c = fakeConn((id) => ({ id, ok: false, exit: 6, json: null, stdout: "", stderr: "INPUT_FAILED: injected 0 (Win32Error=5)", at: "t" }));
    await expect(c.command("input")).rejects.toMatchObject({ code: "restricted" });
    const c2 = fakeConn((id) => ({ id, ok: false, exit: 3, json: null, stdout: "", stderr: "PROCESS_NOT_FOUND: no windows", at: "t" }));
    await expect(c2.command("uia-tree")).rejects.toMatchObject({ code: "element_not_found" });
  });

  it("ping surfaces device_offline on timeout", async () => {
    const c = fakeConn(() => "PENDING");
    await expect(c.ping(30)).rejects.toMatchObject({ code: "device_offline" });
  });

  it("tolerates a UTF-8 BOM on results", async () => {
    const c = new SshQueueConnector({
      sshHost: "h",
      remoteRoot: "C:\\r",
      pollIntervalMs: 1,
      exec: async (_cmd, args) => {
        const remote = args[args.length - 1] as string;
        if (remote.includes("EncodedCommand")) return { stdout: "", stderr: "" };
        return { stdout: "\uFEFF" + JSON.stringify({ id: "z", ok: true, exit: 0, stdout: "S", stderr: "", at: "t" }), stderr: "" };
      },
    });
    const r = await c.command("ping");
    expect(r.stdout).toBe("S");
  });
});
