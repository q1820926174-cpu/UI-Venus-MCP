/**
 * REAL Windows E2E on a GitHub Actions windows-latest runner (the free
 * test machine). Drives the TS adapter end-to-end — not just the PS1
 * bridges: launch charmap → UIA tree → semantic setValue + read-back →
 * capture (real-image check) → input probes (capability-gated, honest).
 *
 * Locale-proof: the editable element is found by ROLE, not by localized
 * name. Every step lands in a JSON report (uploaded as a CI artifact).
 *
 * Hard assertions (known to work on runners): launch, tree, semantic
 * write+read-back, real capture. Soft (reported, non-fatal): SendInput.
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
process.env.CUMCP_PROVIDER = process.env.CUMCP_PROVIDER ?? "mock"; // real-platform E2E needs no vision model

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { buildContext } = await import(pathToFileURL(join(root, "dist/context.js")).href);
const { parseAction } = await import(pathToFileURL(join(root, "dist/core/actions.js")).href);

const report = { startedAt: new Date().toISOString(), platform: process.platform };
const log = (...a) => {
  const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  console.log(line);
  report.log = (report.log ?? "") + line + "\n";
};
const hard = (name, ok, detail) => {
  report.steps = report.steps ?? {};
  report.steps[name] = { ok, detail };
  log(`${ok ? "✓" : "✗"} ${name}: ${typeof detail === "object" ? JSON.stringify(detail) : (detail ?? "")}`);
  if (!ok) report.failed = (report.failed ?? 0) + 1;
};
const soft = (name, ok, detail) => {
  report.steps = report.steps ?? {};
  report.steps[name] = { ok, soft: true, detail };
  log(`${ok ? "✓" : "⊘"} [soft] ${name}: ${typeof detail === "object" ? JSON.stringify(detail) : (detail ?? "")}`);
};

const ctx = await buildContext();
const session = await ctx.router.getSession({ type: "local", platform: "windows" });
const adapter = session.adapter;

hard("open-capabilities", session.info.platform === "windows", adapter.getCapabilities());

// ---- launch a classic Win32 app with a real EDIT control (poll for its window)
let appLaunched = "charmap";
await adapter.launchApp("charmap");
let windows = [];
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  windows = await adapter.listWindows().catch(() => []);
  if (windows.length > 0) break;
}
if (windows.length === 0) {
  // retry with classic notepad (Windows Server runners keep the win32 one)
  appLaunched = "notepad";
  await adapter.launchApp("notepad").catch(() => {});
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    windows = await adapter.listWindows().catch(() => []);
    if (windows.length > 0) break;
  }
}
report.windows = windows.map((w) => w.title);
hard("app-window-visible", windows.length > 0, { app: appLaunched, windows: report.windows.slice(0, 8) });

// observe() scopes UIA to the FOREGROUND window — bring our app to front
// first (title-bar click, the reliable method that also worked on 151)
const target = windows.find((w) => /Character Map|字符映射表|Notepad|记事本/i.test(w.title));
if (target?.bounds) {
  const tx = Math.round(target.bounds.x + target.bounds.width / 2);
  const ty = Math.round(target.bounds.y + 10);
  const front = await adapter.executeAction(parseAction({ type: "click", point: { x: tx, y: ty, space: "physical" } }));
  soft("bring-to-front", front.ok, { at: [tx, ty], error: front.error?.message });
  await new Promise((r) => setTimeout(r, 800));
}

// ---- tree: find an editable element by ROLE (locale-proof) with diagnostics
const obs = await adapter.observe({ includeScreenshot: false, includeUITree: true, maxTreeDepth: 14 });
let editable;
let nodeCount = 0;
const roleCensus = {};
const walk = (n) => {
  if (!n) return;
  nodeCount++;
  roleCensus[n.role ?? "?"] = (roleCensus[n.role ?? "?"] ?? 0) + 1;
  if (!editable && (n.editable || /edit|document/i.test(n.role ?? ""))) editable = n;
  for (const c of n.children ?? []) walk(c);
};
walk(obs.uiTree);
report.tree = { nodeCount, roleCensus };
if (!editable && nodeCount > 0) {
  // fallback: descriptor-based locate through the adapter itself
  const hit = await adapter.locate({ role: "edit" }).catch(() => null);
  if (hit?.element) editable = hit.element;
}
hard("uia-tree-editable-found", !!editable, editable ? { role: editable.role, name: editable.name, id: editable.id, tree: nodeCount } : { tree: nodeCount, roleCensus });

// ---- semantic setValue + read-back
if (editable) {
  const payload = "UIVENUS-CI-写入测试-123";
  const r = await adapter.executeAction(parseAction({ type: "set_value", element: editable, value: payload }));
  const obs2 = await adapter.observe({ includeScreenshot: false, includeUITree: true, maxTreeDepth: 14 });
  let after;
  const walk2 = (n) => {
    if (after || !n) return;
    if (n.id === editable.id) { after = n; return; }
    for (const c of n.children ?? []) walk2(c);
  };
  walk2(obs2.uiTree);
  const ok = r.ok && (after?.value ?? "").includes(payload.slice(0, 12));
  hard("semantic-setvalue-readback", ok, { executed: r.ok, method: r.method, value: (after?.value ?? "").slice(0, 40), error: r.error?.message });
}

// ---- real capture (non-black)
try {
  const shot = await adapter.screenshot();
  hard("capture-real", shot.dataBase64.length > 5000 && shot.width >= 800, { w: shot.width, h: shot.height, kb: Math.round(shot.dataBase64.length / 1024) });
  writeFileSync(join(root, "ci-win-shot.png"), Buffer.from(shot.dataBase64, "base64"));
} catch (e) {
  hard("capture-real", false, e.message.slice(0, 120));
}

// ---- input probes (capability-gated, soft — runner session dependent)
const caps = adapter.getCapabilities();
if (caps.globalInput) {
  const key = await adapter.executeAction(parseAction({ type: "press", key: "enter" }));
  soft("sendinput-key", key.ok, key.error?.message ?? "injected");
  const mv = await adapter.executeAction(parseAction({ type: "move", point: { x: 200, y: 200, space: "screenshot" } }));
  soft("sendinput-move", mv.ok, mv.error?.message ?? "moved");
} else {
  soft("sendinput-key", false, `globalInput=false (${(caps.notes ?? []).join("; ").slice(0, 80)})`);
}

await adapter.terminateApp(appLaunched).catch(() => {});
report.finishedAt = new Date().toISOString();
writeFileSync(join(root, "ci-win-report.json"), JSON.stringify(report, null, 2));
log(report.failed ? `FAILED steps: ${report.failed}` : "ALL HARD STEPS PASSED");
process.exit(report.failed ? 1 : 0);
