/** MICRO-UI stress: 8-10px targets, 1-3px gaps, 14px inputs, 9px links. */
import { join } from "node:path";
const root = "/Users/gold/UI-Venus-mcp";
const { RemoteWindowsAdapter } = await import(join(root, "dist/platforms/windows/remote-ssh.js"));
const adapter = new RemoteWindowsAdapter({ sshHost: "goldagent-151", remoteRoot: "C:\\Users\\gold\\win-remote", screenshot: { maxDimension: 1600 } });
await adapter.open();
const b = (op, extra) => adapter.bridgeCommand(op, extra, 30000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
let pass = 0, fail = 0;
const t = async (n, f) => { try { const d = await f(); pass++; console.log(`✓ ${n} ${typeof d === "object" ? JSON.stringify(d) : d}`); } catch (e) { fail++; console.log(`✗ ${n} — ${e.message.slice(0, 130)}`); } };

async function els() {
  const r = await b("uia-tree", { args: { windowTitle: "极限微靶场", maxDepth: 16, maxNodes: 700 } });
  return JSON.parse(r.stdout);
}
const aria = (arr, l) => (Array.isArray(arr) ? arr : []).find((e) => (e.name ?? "").trim() === l) ?? null;
async function status(id) {
  const arr = await els();
  const el = (Array.isArray(arr) ? arr : []).find((e) => /完成|命中|点错|输入为|勾选|链接/.test(e.name ?? "") && (e.name ?? "").length < 60);
  // status divs per stage — grab by nearest to stage? simpler: read all, filter fresh
  return arr;
}
const clickTiny = async (label, desc) => {
  const arr = await els();
  const el = aria(arr, label);
  if (!el?.bounds) throw new Error(`${desc}: "${label}" not in tree`);
  if (el.bounds.width > 44 || el.bounds.height > 30) throw new Error(`${desc}: bounds unexpectedly large (${el.bounds.width}x${el.bounds.height})`);
  const p = { x: Math.round(el.bounds.x + el.bounds.width / 2), y: Math.round(el.bounds.y + el.bounds.height / 2), space: "physical" };
  const r = await adapter.executeAction({ type: "click", point: p });
  if (!r.ok) throw new Error(`${desc} click failed: ${r.error?.message}`);
  await sleep(350);
  return { p, size: `${el.bounds.width}x${el.bounds.height}` };
};

await b("apps", { mode: "kill", args: { name: "msedge" } }).catch(() => {});
await sleep(600);
await b("apps", { mode: "launch", args: { app: EDGE, args: ["--kiosk", "file:///C:/Users/gold/win-remote/calibration-micro.html", "--edge-kiosk-type=fullscreen", "--no-first-run"] } });
for (let i = 0; i < 40; i++) { await sleep(1500); const r = await b("uia-tree", { args: { windowTitle: "极限微靶场", maxDepth: 10, maxNodes: 200 } }).catch(() => null); if (r && /微钮|VERDICT/.test(r.stdout)) break; }
await t("page up (micro targets in tree)", async () => {
  const arr = await els();
  if (!aria(arr, "微钮0")) throw new Error("micro buttons not exposed");
  return "ok";
});

// discover targets by color? No — read target set from page: targets have aria 微钮N; the page knows.
// The DRIVER can't know which are targets (random). So: iterate ALL 24, click only those that are "t"?
// Strategy: click every button; wrong clicks are recorded by page but don't break completion.
// That would be cheating the intent. Proper way: read button colors via screenshot pixel sampling!
// Simpler honest way: give driver the targets via a page-exposed hint element? No — that defeats blind test.
// REAL approach: use computer_locate (vision) per target! The fusion locator must find orange buttons.
// We do BOTH: (a) vision locate "orange target" rounds, (b) direct aria precision clicks on known-targets via pixel sampling.

// UIA-bounds + pixel-color fusion: the tree gives EXACT bounds for every
// tiny button; sample the screenshot pixel at each center to identify
// targets by color; click precisely. This is the honest extreme test:
// 10px target, 3px gaps — zero room for error.
const { decodeImage } = await import(join(root, "dist/screenshot/pipeline.js"));
async function shotImg() {
  const s = await adapter.screenshot();
  return { img: decodeImage(Buffer.from(s.dataBase64, "base64")), w: s.width, h: s.height };
}
function pixelAt(img, x, y) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return null;
  const i = (Math.round(y) * img.width + Math.round(x)) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}
const isOrange = ([r, g, b]) => r > 210 && g > 110 && g < 200 && b < 110;
const isCyan = ([r, g, b]) => r < 110 && g > 160 && b > 180;

async function hitColorTargets(ariaPrefix, count, colorFn, stageTag) {
  const { img } = await shotImg();
  const arr = await els();
  const btns = (Array.isArray(arr) ? arr : [])
    .filter((e) => (e.name ?? "").startsWith(ariaPrefix) && e.bounds && e.bounds.width <= 20)
    .map((e) => ({ name: e.name.trim(), b: e.bounds }))
    .sort((a, b2) => (a.b.y - b2.b.y) || (a.b.x - b2.b.x));
  if (btns.length === 0) throw new Error(`no ${ariaPrefix}* buttons in tree`);
  // map physical → screenshot coords: screenshot may be downscaled
  const arr2 = await els();
  const targets = [];
  const shot = await adapter.screenshot();
  const imgS = decodeImage(Buffer.from(shot.dataBase64, "base64"));
  for (const { name, b } of btns) {
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2; // physical
    const sx = (cx / 1920) * shot.width, sy = (cy / 1080) * shot.height;
    // 8px targets may downscale to ~6px — sample 5 offsets, any hit counts
    const offs = [[0, 0], [-2, 0], [2, 0], [0, -2], [0, 2]];
    const hit = offs.some(([dx, dy]) => {
      const px = pixelAt(imgS, sx + dx, sy + dy);
      return px && colorFn(px);
    });
    if (hit) targets.push({ name, b });
  }
  if (targets.length < count) throw new Error(`found ${targets.length}/${count} ${stageTag} targets`);
  for (const { b } of targets) {
    await adapter.executeAction({ type: "click", point: { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), space: "physical" } });
    await sleep(300);
  }
}

await t("Q1 fusion: 10px orange targets via UIA+pixel (3px gaps)", async () => {
  await hitColorTargets("微钮", 6, isOrange, "Q1");
  const arr = await els();
  const s = (Array.isArray(arr) ? arr : []).find((e) => /Q1 完成|命中 \d|点错/.test(e.name ?? ""));
  if (!s || !/完成/.test(s.name)) throw new Error(s?.name ?? "no status");
  return "Q1 +20";
});

await t("Q2 fusion: 8px cyan targets via UIA+pixel (1px gaps!)", async () => {
  await hitColorTargets("微条", 4, isCyan, "Q2");
  const arr = await els();
  const s = (Array.isArray(arr) ? arr : []).find((e) => /Q2 完成|命中 \d|点错/.test(e.name ?? ""));
  if (!s || !/完成/.test(s.name)) throw new Error(s?.name ?? "no status");
  return "Q2 +20";
});

await t("Q3: 14px micro input — click, type micro, verify", async () => {
  const arr = await els();
  const el = aria(arr, "微型输入框");
  if (!el?.bounds) throw new Error("micro input not found");
  if (el.bounds.height > 30) throw new Error(`input inflated: ${el.bounds.height}px`);
  const p = { x: Math.round(el.bounds.x + 40), y: Math.round(el.bounds.y + el.bounds.height / 2), space: "physical" };
  await adapter.executeAction({ type: "click", point: p });
  await sleep(300);
  await adapter.executeAction({ type: "type", text: "micro" });
  await sleep(400);
  await clickTiny("微校验", "Q3 verify btn");
  const arr2 = await els();
  const s = (Array.isArray(arr2) ? arr2 : []).find((e) => /Q3 完成|输入为/.test(e.name ?? ""));
  if (!s || !/完成/.test(s.name)) throw new Error(s?.name ?? "no status");
  return "Q3 done +20";
});

await t("Q4: two 9px native checkboxes 甲+丙 then judge", async () => {
  await clickTiny("微选甲", "Q4 甲");
  await sleep(300);
  await clickTiny("微选丙", "Q4 丙");
  await sleep(300);
  await clickTiny("微选判定", "Q4 judge");
  const arr = await els();
  const s = (Array.isArray(arr) ? arr : []).find((e) => /Q4 完成\+20|Q4 完成/.test(e.name ?? "") || /^当前勾选/.test(e.name ?? ""));
  if (!s || !/完成/.test(s.name)) throw new Error(s?.name ?? "no status (maybe checkbox missed)");
  return "Q4 done +20";
});

await t("Q5: 9px dense-text links 金木水", async () => {
  for (const v of ["金", "木", "水"]) {
    await clickTiny(`密链${v}`, `Q5 ${v}`);
    await sleep(350);
  }
  const arr = await els();
  const s = (Array.isArray(arr) ? arr : []).find((e) => /Q5 完成|链接 \d/.test(e.name ?? ""));
  if (!s || !/完成/.test(s.name)) throw new Error(s?.name ?? "no status");
  return "Q5 done +20";
});

await t("final verdict", async () => {
  const arr = await els();
  const v = (Array.isArray(arr) ? arr : []).find((e) => /VERDICT/.test(e.name ?? ""));
  const sc = (Array.isArray(arr) ? arr : []).find((e) => /得分/.test(e.name ?? ""));
  if (!/PASS ALL/.test(v?.name ?? "")) throw new Error(`${v?.name} ${sc?.name}`);
  return sc?.name;
});

await b("apps", { mode: "kill", args: { name: "msedge" } });
console.log(`\n===== MICRO STRESS: ${pass}✓ ${fail}✗ =====`);
process.exit(fail ? 1 : 0);
