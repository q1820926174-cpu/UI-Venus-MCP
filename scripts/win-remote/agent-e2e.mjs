/**
 * Windows agent E2E — official-style multi-step GUI task (OSWorld flavor).
 * Runs ON the Windows test host inside the interactive session:
 *   env: UI-Venus endpoint via SSH reverse tunnel (127.0.0.1:18300)
 *   task: Calculator is pre-launched; the model must compute 7 × 3 via
 *         vision-driven clicks (7, ×, 3, =) and finish; verification reads
 *         the result (21) from the screen.
 * Writes agent-e2e-result.json next to this file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const envCfg = JSON.parse(readFileSync(join(here, "agent-e2e.env.json"), "utf8"));
process.env.VENUS_BASE_URL = envCfg.VENUS_BASE_URL;
process.env.VENUS_API_KEY = envCfg.VENUS_API_KEY;
process.env.VENUS_MODEL = envCfg.VENUS_MODEL ?? "UI-Venus-2-9B-W8A8";
process.env.VENUS_ALLOW_INSECURE_HTTP = "true";

const { loadConfig } = await import(join(here, "dist/config.js"));
const { WindowsAdapter } = await import(join(here, "dist/platforms/windows/adapter.js"));
const { PlatformRouter } = await import(join(here, "dist/platforms/router.js"));
const { UiVenusProvider } = await import(join(here, "dist/providers/ui-venus/provider.js"));
const { TaskOrchestrator } = await import(join(here, "dist/orchestrator/executor.js"));

const out = { startedAt: new Date().toISOString(), host: process.env.COMPUTERNAME };
const log = (...a) => {
  const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  console.log(line);
  out.log = (out.log ?? "") + line + "\n";
};

try {
  const cfg = loadConfig();
  const adapter = new WindowsAdapter();
  const router = new PlatformRouter();
  router.register({ platform: "windows", factory: async () => adapter, probe: async () => ({ available: true }) });
  const provider = new UiVenusProvider(cfg.venus);
  const orch = new TaskOrchestrator(router, provider, cfg);

  // environment setup (OSWorld-style: app is provided, model does the interaction)
  log("opening Calculator…");
  await adapter.launchApp("calc");
  await new Promise((r) => setTimeout(r, 3500));

  const obs0 = await adapter.observe();
  log("screenshot:", obs0.screenshot?.width + "x" + obs0.screenshot?.height, "scale:", obs0.screenshot?.scale);
  out.capabilities = adapter.getCapabilities();

  const task = "使用计算器计算 7 乘以 3（依次点击 7、乘号、3、等号），完成后结束任务";
  const record = await orch.executeTask({
    target: { type: "local", platform: "windows" },
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
    error: s.error?.slice?.(0, 160),
    thought: s.acceptedResponse?.slice?.(0, 220),
  }));
  log("outcome:", record.outcome?.status, "|", record.outcome?.reason ?? record.outcome?.evidence ?? "");
  for (const s of out.steps) log(`  step ${s.i}: ${s.summary} ${s.ok ? "✓" : "✗"} ${s.error ?? ""}`);

  // final screenshot for evidence
  const finalShot = await adapter.screenshot();
  writeFileSync(join(here, "agent-e2e-final.png"), Buffer.from(finalShot.dataBase64, "base64"));
  out.finalScreenshot = { width: finalShot.width, height: finalShot.height, hash: finalShot.hash };
} catch (e) {
  out.fatal = e?.stack?.slice(0, 800) ?? String(e);
  log("FATAL:", out.fatal);
}

// cleanup
try {
  const { execFile } = await import("node:child_process");
  execFile("taskkill", ["/IM", "CalculatorApp.exe", "/F"], () => {});
  execFile("taskkill", ["/IM", "charmap.exe", "/F"], () => {});
} catch {}

out.finishedAt = new Date().toISOString();
writeFileSync(join(here, "agent-e2e-result.json"), JSON.stringify(out, null, 2));
log("DONE -> agent-e2e-result.json");
