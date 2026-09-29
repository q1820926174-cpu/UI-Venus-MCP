/** Gauntlet driver v2b: aria-labeled targets, taskbar assertion after every
 *  sub-step, sequential gating (stop on first stage failure). */
import { join } from "node:path";
const root = "/Users/gold/UI-Venus-mcp";
const { RemoteWindowsAdapter } = await import(join(root, "dist/platforms/windows/remote-ssh.js"));
const adapter = new RemoteWindowsAdapter({ sshHost: "goldagent-151", remoteRoot: "C:\\Users\\gold\\win-remote", screenshot: { maxDimension: 1600 } });
await adapter.open();
const b = (op, extra) => adapter.bridgeCommand(op, extra, 30000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { const d = await fn(); pass++; console.log(`✓ ${name} ${typeof d === "object" ? JSON.stringify(d) : (d ?? "")}`); return true; }
  catch (e) { fail++; console.log(`✗ ${name} — ${e.message.slice(0, 150)}`); return false; }
};
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

async function els() {
  const r = await b("uia-tree", { args: { windowTitle: "校对靶场-进阶", maxDepth: 18, maxNodes: 700 } });
  return JSON.parse(r.stdout);
}
const byAria = (arr, label) => (Array.isArray(arr) ? arr : []).find((e) => (e.name ?? "").trim() === label) ?? null;
async function stageScore() {
  const arr = await els();
  const s = byAria(arr, (n) => 0, "") ?? null; void s;
  const st = (Array.isArray(arr) ? arr : []).find((e) => /阶段:/.test(e.name ?? ""));
  const sc = (Array.isArray(arr) ? arr : []).find((e) => /得分/.test(e.name ?? ""));
  return { stage: (st?.name ?? "").trim(), score: (sc?.name ?? "").trim(), arr };
}
async function taskbar() {
  const arr = await els();
  const cands = (Array.isArray(arr) ? arr : []).filter((e) => (e.name ?? "").includes("登录") || (e.name ?? "").includes("手持") || (e.name ?? "").includes("已按序") || ((e.name ?? "").includes("✓") && (e.name ?? "").includes("○")));
  return (cands[0]?.name ?? "(none)").replace(/\s+/g, " ").slice(0, 110);
}
async function loginEnabled() {
  const arr = await els();
  const btn = byAria(arr, "登录按钮");
  return btn ? btn.enabled !== false : null;
}
const clickAria = async (label, desc, fracX = 0.5) => {
  const arr = await els();
  const el = byAria(arr, label);
  if (!el?.bounds) throw new Error(`${desc ?? label}: aria "${label}" not found`);
  const p = { x: Math.round(el.bounds.x + el.bounds.width * fracX), y: Math.round(el.bounds.y + el.bounds.height / 2), space: "physical" };
  const r = await adapter.executeAction({ type: "click", point: p });
  if (!r.ok) throw new Error(`${desc ?? label} click failed`);
  return p;
};
const typeAria = async (label, text) => {
  const arr = await els();
  const el = byAria(arr, label);
  if (!el?.bounds) throw new Error(`input aria "${label}" not found`);
  const p = { x: Math.round(el.bounds.x + el.bounds.width / 2), y: Math.round(el.bounds.y + el.bounds.height / 2), space: "physical" };
  await adapter.executeAction({ type: "click", point: p });
  await sleep(350);
  await adapter.executeAction({ type: "type", text });
  await sleep(450);
};
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

// ── launch ──
await b("apps", { mode: "kill", args: { name: "msedge" } }).catch(() => {});
await sleep(600);
await b("apps", { mode: "launch", args: { app: EDGE, args: ["--kiosk", "file:///C:/Users/gold/win-remote/calibration-v2.html", "--edge-kiosk-type=fullscreen", "--no-first-run"] } });
for (let i = 0; i < 40; i++) { await sleep(1500); const { stage } = await stageScore(); if (stage.includes("T1")) break; }
const ok0 = await t("T0 page up (stage T1)", async () => {
  const { stage } = await stageScore();
  expect(stage.includes("T1"), `stage="${stage}"`);
  return stage;
});
if (!ok0) { console.log("page never came up — abort"); process.exit(1); }

// ── T1 ──
const ok1 = await t("T1 form chain (aria inputs + select expand + gated login) → T2", async () => {
  await typeAria("用户名输入", "UIVENUS");
  await typeAria("邮箱输入", "test@z.ai");
  await clickAria("部门选择", "dept select");
  await sleep(600);
  await adapter.executeAction({ type: "press", key: "down" });
  await sleep(200);
  await adapter.executeAction({ type: "press", key: "enter" });
  await sleep(500);
  await typeAria("备注输入", "自动化备注通过");
  const en = await loginEnabled();
  const arr2 = await els();
  const markers = arr2.filter((e) => /[✓○]/.test(e.name ?? "")).map((e) => e.name.trim());
  const editsNow = arr2.filter((e) => (e.role ?? "") === "ControlType.Edit").map((e) => [(e.name ?? "").trim().slice(0, 10), (e.value ?? "").slice(0, 16)]);
  expect(en === true, `login not enabled (${en}); markers=${JSON.stringify(markers)} edits=${JSON.stringify(editsNow)}`);
  await clickAria("登录按钮", "login");
  await sleep(1000);
  const { stage, score } = await stageScore();
  expect(stage.includes("T2"), `stage="${stage}"`);
  expect(score.includes("20"), `score="${score}"`);
  return `${stage} ${score}`;
});
if (!ok1) { console.log("T1 failed — later stages gated by design"); }

// ── T2 ──
const ok2 = ok1 && await t("T2 five 44px buttons in order → T3 (+20)", async () => {
  for (let want = 1; want <= 5; want++) {
    const arr = await els();
    const btn = arr.find((e) => (e.role ?? "") === "ControlType.Button" && (e.name ?? "").trim() === String(want) && e.bounds.height < 60);
    expect(btn?.bounds, `seq button ${want} not found`);
    const p = { x: Math.round(btn.bounds.x + btn.bounds.width / 2), y: Math.round(btn.bounds.y + btn.bounds.height / 2), space: "physical" };
    await adapter.executeAction({ type: "click", point: p });
    await sleep(550);
    if (want < 5) {
      const tb = await taskbar();
      expect(tb.includes(`${want}/5`), `progress marker missing after ${want}: "${tb}"`);
    }
  }
  await sleep(900);
  const { stage, score } = await stageScore();
  expect(stage.includes("T3"), `stage="${stage}"`);
  return `${stage} ${score}`;
});

// ── T3 ──
const ok3 = (ok2 || ok1) && await t("T3 wheels 7/3/9 via aria + / − buttons → T4 (+20)", async () => {
  const targets = [7, 3, 9], names = ["转盘一", "转盘二", "转盘三"];
  for (let w = 0; w < 3; w++) {
    for (let k = 0; k < targets[w]; k++) {
      await clickAria(`${names[w]}加`, `w${w}+${k + 1}`);
      await sleep(260);
    }
  }
  await clickAria("校验转盘", "check");
  await sleep(900);
  const { stage, score } = await stageScore();
  expect(stage.includes("T4"), `stage="${stage}"`);
  return `${stage} ${score}`;
});

// ── T4 ──
const ok4 = ok3 && await t("T4 carry 金/木/水 into aria slots → T5 (+20)", async () => {
  for (const v of ["金", "木", "水"]) {
    await clickAria(`碎片${v}`, `pick ${v}`);
    await sleep(450);
    let tb = await taskbar();
    expect(tb.includes(`手持 ${v}`), `carry marker missing: "${tb}"`);
    await clickAria(`槽位${v}`, `drop ${v}`);
    await sleep(550);
  }
  await sleep(800);
  const { stage, score } = await stageScore();
  expect(stage.includes("T5"), `stage="${stage}"`);
  return `${stage} ${score}`;
});

// ── T5 ──
if (ok4) await t("T5 two checkboxes + note 通过 + submit → DONE 100/100", async () => {
  // checkbox renders as a small box at the LEFT of its cell (DataItem 146px,
  // box ~13px) — cell-center clicks hit dead space; click the left edge
  await clickAria("勾选张三", "张三 cell");
  await sleep(450);
  await clickAria("勾选李四", "李四 cell");
  await sleep(450);
  await typeAria("审批备注输入", "通过");
  await clickAria("提交审批", "submit");
  await sleep(1000);
  const s5 = await stageScore();
  const logs = s5.arr.filter((e) => /T5/.test(e.name ?? "")).map((e) => e.name.trim()).slice(0, 4);
  expect(s5.stage.includes("DONE"), `stage="${s5.stage}" score="${s5.score}" logs=${JSON.stringify(logs)}`);
  return `GAUNTLET COMPLETE ${s5.stage} ${s5.score}`;
});

await b("apps", { mode: "kill", args: { name: "msedge" } });
console.log(`\n===== GAUNTLET v2: ${pass} passed / ${fail} failed =====`);
process.exit(fail ? 1 : 0);
