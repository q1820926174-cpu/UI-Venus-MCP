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

// ---- launch a classic Win32 app with a real EDIT control
await adapter.launchApp("charmap");
await new Promise((r) => setTimeout(r, 4000));

// ---- tree: find an editable element by ROLE (locale-proof)
const obs = await adapter.observe({ includeScreenshot: false, includeUITree: true, maxTreeDepth: 14 });
let editable;
const walk = (n) => {
  if (editable || !n) return;
  if (n.editable || /edit|document/i.test(n.role ?? "")) { editable = n; return; }
  for (const c of n.children ?? []) walk(c);
};
walk(obs.uiTree);
hard("uia-tree-editable-found", !!editable, editable ? { role: editable.role, name: editable.name, id: editable.id } : "no editable element");

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
  const key = await adapter.executeAction(parseAction({ type: "press", key: "escape" }));
  soft("sendinput-key", key.ok, key.error?.message ?? "injected");
  const mv = await adapter.executeAction(parseAction({ type: "move", point: { x: 200, y: 200, space: "screenshot" } }));
  soft("sendinput-move", mv.ok, mv.error?.message ?? "moved");
} else {
  soft("sendinput-key", false, `globalInput=false (${(caps.notes ?? []).join("; ").slice(0, 80)})`);
}

await adapter.terminateApp("charmap").catch(() => {});
report.finishedAt = new Date().toISOString();
writeFileSync(join(root, "ci-win-report.json"), JSON.stringify(report, null, 2));
log(report.failed ? `FAILED steps: ${report.failed}` : "ALL HARD STEPS PASSED");
process.exit(report.failed ? 1 : 0);
