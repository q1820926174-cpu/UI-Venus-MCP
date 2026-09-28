/**
 * Remote Windows agent E2E — the architecture the spec §13 describes and
 * the model's official demos emulate: the FULL MCP stack (orchestrator +
 * UI-Venus official protocol) runs on THIS machine; the Windows host is a
 * remote executor (screenshot + input via the session-1 queue bridge).
 *
 *   Mac (this script)                    Windows 151 (session 1)
 *   ─────────────────────────            ────────────────────────────
 *   TaskOrchestrator + UI-Venus  ──ssh──▶ queue-agent.ps1
 *   screenshot (PNG, downscaled) ◀──scp── screen.ps1 capture
 *   click(x, y) / type / hotkey  ──ssh──▶ input.ps1 (SendInput)
 *
 * Task (OSWorld-flavor, multi-step): Calculator is pre-launched; the model
 * must click 7 → × → 3 → = and finish; vision verification reads 21.
 *
 * Run from the repo root on the Mac:
 *   node scripts/win-remote/remote-agent-e2e.mjs
 * Env: VENUS_* (loaded from .env), CUMCP_REMOTE_WINDOWS_SSH (default
 * goldagent-151).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

// tiny .env loader (repo .env is gitignored)
const envFile = join(root, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const { loadConfig } = await import(join(root, "dist/config.js"));
const { PlatformRouter } = await import(join(root, "dist/platforms/router.js"));
const { RemoteWindowsAdapter } = await import(join(root, "dist/platforms/windows/remote-ssh.js"));
const { UiVenusProvider } = await import(join(root, "dist/providers/ui-venus/provider.js"));
const { TaskOrchestrator } = await import(join(root, "dist/orchestrator/executor.js"));

const sshHost = process.env.CUMCP_REMOTE_WINDOWS_SSH ?? "goldagent-151";
const out = { startedAt: new Date().toISOString(), architecture: "local MCP → ssh → session-1 bridge → Windows GUI" };
const log = (...a) => {
  const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  console.log(line);
  out.log = (out.log ?? "") + line + "\n";
};

const task = process.argv[2] ?? "使用计算器计算 7 乘以 3（依次点击 7、乘号、3、等号），完成后结束任务";

try {
  const cfg = loadConfig();
  const adapter = new RemoteWindowsAdapter({
    sshHost,
    remoteRoot: "C:\\Users\\gold\\win-remote",
    screenshot: { maxDimension: 1600 },
  });
  const router = new PlatformRouter();
  router.register({ platform: "windows", factory: async () => adapter, probe: async () => ({ available: true }) });
  const provider = new UiVenusProvider(cfg.venus);
  const orch = new TaskOrchestrator(router, provider, cfg);

  log(`target: ${sshHost} (remote windows)`);
  const info = await adapter.open();
  out.capabilities = adapter.getCapabilities();
  log("capabilities:", JSON.stringify(out.capabilities));

  // environment setup: fresh calculator (kill leftovers, launch in session 1),
  // then WAIT until its top-level window is really present (UIA check)
  await adapter.terminateApp("CalculatorApp.exe").catch(() => {});
  await adapter.launchApp("calc");
  // detect + focus the calculator window via REMOTE-side title matching
  // (ArgsJson travels base64/UTF8 both ways — immune to console mojibake)
  let calcBounds = null;
  for (let i = 0; i < 10 && !calcBounds; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await adapter
      .bridgeCommand("uia-tree", { args: { windowTitle: "计算器", maxDepth: 1 } })
      .catch(() => null);
    if (res) {
      try {
        const elements = JSON.parse(res.stdout);
        const win = (Array.isArray(elements) ? elements : []).find(
          (e) => e.role === "ControlType.Window" && e.bounds && e.bounds.width > 100,
        );
        if (win) calcBounds = win.bounds;
      } catch {}
    }
  }
  log(`calculator window found: ${!!calcBounds}${calcBounds ? ` bounds=${JSON.stringify(calcBounds)}` : ""}`);
  if (calcBounds) {
    // windows can't SetFocus directly — a title-bar click brings it to front
    const tx = Math.round(calcBounds.x + calcBounds.width / 2);
    const ty = Math.round(calcBounds.y + 12);
    await adapter
      .bridgeCommand("input", { mode: "click", args: { x: tx, y: ty, button: "left", clicks: 1 } })
      .catch((e) => log("front-click:", e.message));
    await new Promise((r) => setTimeout(r, 1000));
  }

  const record = await orch.executeTask({
    target: { type: "remote", platform: "windows" },
    goal: task,
    mode: "delegate",
    maxSteps: 12,
    language: "zh",
    wait: true,
  });

  out.task = task;
  out.outcome = record.outcome;
  out.steps = record.steps.map((s) => ({
    i: s.index,
    summary: s.summary,
    ok: s.ok,
    method: s.result?.method,
    point: s.result?.point,
    error: typeof s.error === "string" ? s.error.slice(0, 160) : s.error,
    thought: typeof s.acceptedResponse === "string" ? s.acceptedResponse.slice(0, 260) : s.acceptedResponse,
  }));
  log(`outcome: ${record.outcome?.status} | ${record.outcome?.reason ?? record.outcome?.evidence ?? ""}`);
  for (const s of out.steps) log(`  step ${s.i}: ${s.summary} ${s.ok ? "✓" : "✗"}${s.error ? " " + s.error : ""}`);

  // evidence: final screenshot fetched locally
  const finalShot = await adapter.screenshot();
  writeFileSync(join(root, "tests", "e2e", "__remote-win-final.png"), Buffer.from(finalShot.dataBase64, "base64"));
  out.finalScreenshot = { width: finalShot.width, height: finalShot.height, hash: finalShot.hash };

  // cleanup
  await adapter.terminateApp("CalculatorApp.exe").catch(() => {});
} catch (e) {
  out.fatal = e?.stack?.slice(0, 900) ?? String(e);
  log("FATAL:", out.fatal);
}

out.finishedAt = new Date().toISOString();
writeFileSync(join(root, "tests", "e2e", "__remote-win-agent-result.json"), JSON.stringify(out, null, 2));
log("DONE → tests/e2e/__remote-win-agent-result.json");
