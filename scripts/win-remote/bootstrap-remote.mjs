/**
 * bootstrap-remote.mjs — ONE command to onboard a new "奇葩" Windows host
 * for remote control (the 151 pattern, automated):
 *
 *   node scripts/win-remote/bootstrap-remote.mjs goldagent-151 [C:\Users\gold\win-remote]
 *
 * Steps (all idempotent):
 *   1. SSH key-auth check + session reality (query user)
 *   2. Transfer the inbox bridges (screen/input/apps/uia ps1) + queue-agent + hidden launcher
 *   3. Activate the logged-on console session if disconnected (tscon)
 *   4. (Re)install the hidden session-1 queue agent via schtasks /IT + wscript
 *   5. Verify: bridge ping → real capture → binary fetch; JSON report
 *
 * Afterwards register the target on the MCP side:
 *   export CUMCP_REMOTES='[{"name":"win-151","platform":"windows","kind":"ssh-queue","sshHost":"goldagent-151","root":"C:\\Users\\gold\\win-remote"}]'
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sshHost = process.argv[2];
const remoteRoot = process.argv[3] ?? "C:\\Users\\gold\\win-remote";
if (!sshHost) {
  console.error("usage: node scripts/win-remote/bootstrap-remote.mjs <ssh-alias> [remoteRoot]");
  process.exit(1);
}
const SSH = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
const report = { sshHost, remoteRoot, steps: {} };
const step = async (name, fn) => {
  try {
    report.steps[name] = await fn();
    console.log(`✓ ${name}:`, JSON.stringify(report.steps[name]).slice(0, 140));
  } catch (e) {
    report.steps[name] = { error: e.message.slice(0, 200) };
    console.error(`✗ ${name}:`, e.message.slice(0, 200));
    process.exitCode = 1;
  }
};
const run = (cmd, args) => exec(cmd, args, { timeout: 60_000 }).then((r) => r.stdout);
const ssh = (c) => run("ssh", [...SSH, sshHost, c]);

await step("ssh-key-auth", async () => {
  const whoami = (await ssh("whoami")).trim();
  return { whoami };
});

await step("session-reality", async () => {
  const q = await ssh("query user").catch(() => "no sessions");
  return { sessions: q.trim().split("\n").length - 1, raw: q.trim().slice(0, 120) };
});

await step("transfer-bridges", async () => {
  await ssh(`powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path ${remoteRoot}\\scripts, ${remoteRoot}\\queue, ${remoteRoot}\\results | Out-Null"`);
  const here = join(root, "scripts", "win-remote");
  const src = join(root, "src", "platforms", "windows", "scripts");
  await run("scp", [...SSH, `${src}/*.ps1`, `${sshHost}:win-remote-tmp/`]).catch(async () => {
    // remoteRoot may differ from the default ~/win-remote — copy via a staging dir
    await ssh("powershell -NoProfile -Command \"New-Item -ItemType Directory -Force -Path win-remote-tmp | Out-Null\"");
    await run("scp", [...SSH, `${src}/screen.ps1`, `${src}/input.ps1`, `${src}/apps.ps1`, `${src}/sysinfo.ps1`, `${src}/uia-tree.ps1`, `${src}/uia-action.ps1`, `${sshHost}:win-remote-tmp/`]);
  });
  await run("scp", [...SSH, join(here, "queue-agent.ps1"), `${sshHost}:win-remote-tmp/`]);
  // hidden launcher pointing at the actual remoteRoot
  const vbs = `CreateObject("Wscript.Shell").Run "powershell -NoProfile -ExecutionPolicy Bypass -File ${remoteRoot}\\queue-agent.ps1", 0, False\r\n`;
  writeFileSync(join(tmpdir(), "cumcp-run-hidden.vbs"), vbs, "utf8");
  await run("scp", [...SSH, join(tmpdir(), "cumcp-run-hidden.vbs"), `${sshHost}:win-remote-tmp/run-hidden.vbs`]);
  await ssh(`powershell -NoProfile -Command "Move-Item -Force win-remote-tmp\\*.ps1 ${remoteRoot}\\; Move-Item -Force win-remote-tmp\\run-hidden.vbs ${remoteRoot}\\; Remove-Item -Recurse -Force win-remote-tmp -ErrorAction SilentlyContinue"`);
  const files = await ssh(`powershell -NoProfile -Command "(Get-ChildItem ${remoteRoot} -Filter *.ps1).Count"`);
  return { scripts: Number(files.trim()) };
});

await step("activate-console-session", async () => {
  const before = await ssh("query user 2>nul").catch(() => "");
  const disc = /Disc|断开/i.test(before);
  if (disc) {
    await ssh("tscon 1 /dest:console").catch((e) => console.log("   tscon:", e.message.slice(0, 80)));
    await new Promise((r) => setTimeout(r, 1500));
  }
  const after = await ssh("query user 2>nul").catch(() => "");
  return { wasDisconnected: disc, activeNow: !/Disc|断开/i.test(after) };
});

await step("install-bridge", async () => {
  await ssh(`schtasks /end /tn uivenus-bridge 2>nul`).catch(() => {});
  await ssh(`schtasks /delete /tn uivenus-bridge /f 2>nul`).catch(() => {});
  // stop any stale bridge console (EncodedCommand avoids quoting issues)
  const killPs = "Get-Process WindowsTerminal -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*queue-agent*' } | Stop-Process -Force -ErrorAction SilentlyContinue";
  await ssh(`powershell -NoProfile -EncodedCommand ${Buffer.from(killPs, "utf16le").toString("base64")}`).catch(() => {});
  // a stale queue-agent from a previous install keeps serving; retire it so
  // the fresh bridge owns the queue exclusively
  await ssh(`powershell -NoProfile -EncodedCommand ${Buffer.from("Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*queue-agent.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }", "utf16le").toString("base64")}`).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  await ssh(`schtasks /create /tn uivenus-bridge /tr "wscript.exe ${remoteRoot}\\run-hidden.vbs" /sc once /st 23:59 /it /f`);
  await ssh(`schtasks /run /tn uivenus-bridge`);
  await new Promise((r) => setTimeout(r, 4000));
  return { task: "uivenus-bridge", launcher: "wscript (hidden)" };
});

// verification through the freshly installed bridge
const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
const enc = (ps) => Buffer.from(ps, "utf16le").toString("base64");
async function bridge(op, extra = {}, waitMs = 20000) {
  const id = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const ps = `Set-Content -Path '${remoteRoot}\\queue\\${id}.cmd.json' -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64({ id, op, ...extra })}'))) -Encoding UTF8`;
  await ssh(`powershell -NoProfile -EncodedCommand ${enc(ps)}`);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const raw = await ssh(`powershell -NoProfile -Command "if (Test-Path '${remoteRoot}\\results\\${id}.json') { Get-Content -Raw -Encoding UTF8 '${remoteRoot}\\results\\${id}.json' } else { 'PENDING' }"`).catch(() => "PENDING");
    if (raw.trim() !== "PENDING" && raw.trim() !== "") {
      return raw.replace(/^\uFEFF/, "").trim();
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("bridge timeout");
}

await step("verify-ping", async () => {
  const r = JSON.parse(await bridge("ping", {}, 15000));
  if (!r.ok) throw new Error("ping not ok");
  return { ok: true };
});

await step("verify-capture", async () => {
  const id = `v${Date.now().toString(36)}`;
  const r = JSON.parse(await bridge("capture", { out: `${remoteRoot}\\results\\${id}.png` }, 30000));
  const meta = JSON.parse(r.stdout || "{}");
  if (!meta.ok) throw new Error(`capture failed: ${r.stderr?.slice(0, 120)}`);
  const dir = await mkdtemp(join(tmpdir(), "cumcp-boot-"));
  try {
    await run("scp", [...SSH, `${sshHost}:${remoteRoot.replace(/\\/g, "/")}/results/${id}.png`, join(dir, "s.png")]);
    const png = await readFile(join(dir, "s.png"));
    const magic = png.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
    return { width: meta.width, height: meta.height, blackRatio: meta.blackRatio, pngKB: Math.round(png.length / 1024), magic };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

console.log("\nBootstrap report:\n" + JSON.stringify(report, null, 2));
console.log(`\nNext: export CUMCP_REMOTES='[{"name":"win-1","platform":"windows","kind":"ssh-queue","sshHost":"${sshHost}","root":"${remoteRoot.replace(/\\/g, "\\\\")}"}]'`);
