/** Stress A: extreme inputs (byte-exact page-side verification) + scroll precision. */
import { join } from "node:path";
const root = "/Users/gold/UI-Venus-mcp";
const { RemoteWindowsAdapter } = await import(join(root, "dist/platforms/windows/remote-ssh.js"));
const adapter = new RemoteWindowsAdapter({ sshHost: "goldagent-151", remoteRoot: "C:\\Users\\gold\\win-remote", screenshot: { maxDimension: 1600 } });
await adapter.open();
const b = (op, extra) => adapter.bridgeCommand(op, extra, 30000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { const d = await fn(); pass++; console.log(`✓ ${name} ${typeof d === "object" ? JSON.stringify(d) : (d ?? "")}`); return true; }
  catch (e) { fail++; console.log(`✗ ${name} — ${e.message.slice(0, 150)}`); return false; }
};
async function els() {
  const r = await b("uia-tree", { args: { windowTitle: "校对靶场-极限", maxDepth: 18, maxNodes: 700 } });
  return JSON.parse(r.stdout);
}
const aria = (arr, label) => (Array.isArray(arr) ? arr : []).find((e) => (e.name ?? "").trim() === label) ?? null;
const verdictText = async () => {
  const arr = await els();
  const v = (Array.isArray(arr) ? arr : []).find((e) => /VERDICT:/.test(e.name ?? ""));
  return (v?.name ?? "").trim();
};
const clickAria = async (label) => {
  const arr = await els();
  const el = aria(arr, label);
  if (!el?.bounds) throw new Error(`aria "${label}" not found`);
  const p = { x: Math.round(el.bounds.x + el.bounds.width / 2), y: Math.round(el.bounds.y + el.bounds.height / 2), space: "physical" };
  const r = await adapter.executeAction({ type: "click", point: p });
  if (!r.ok) throw new Error(`click ${label} failed`);
  await sleep(350);
};

// CASES must EXACTLY match the page's expectations (calibration-v3.html)
const CASES = {
  "普通英文": "Hello World 123 ABCdef",
  "中日韩混排": "你好世界こんにちは안녕하세요中文测试",
  "表情符号": "🎉🚀✅❤️🤖👍😀🔥💎🌟🎵",
  "引号转义": 'He said "hi" & \'bye\' <tag> 50% + \\path/ "nested \\"deeply\\""',
  "符号冲击": "!@#$%^&*()_+-=[]{}|;:,.<>?/~`€£¥§±×÷≠∞≈",
  "超长文本(300字)": "极限压榨".repeat(60) + "Mixed123结尾",
  "终极混合": "开头🎉中文\"引号\"结束✅emoji+漢字ひらがな한국어123!@#",
};

// launch
await b("apps", { mode: "kill", args: { name: "msedge" } }).catch(() => {});
await sleep(600);
await b("apps", { mode: "launch", args: { app: EDGE, args: ["--kiosk", "file:///C:/Users/gold/win-remote/calibration-v3.html", "--edge-kiosk-type=fullscreen", "--no-first-run"] } });
for (let i = 0; i < 40; i++) { await sleep(1500); if ((await verdictText().catch(() => "")).includes("待测")) break; }

for (const [btnName, text] of Object.entries(CASES)) {
  await t(`X1 [${btnName}] byte-exact (${text.length} chars)`, async () => {
    await clickAria(btnName);
    await clickAria("清空");
    // click into textarea then type
    const arr = await els();
    const ta = aria(arr, "主输入区");
    if (!ta?.bounds) throw new Error("textarea not found");
    const p = { x: Math.round(ta.bounds.x + 60), y: Math.round(ta.bounds.y + 30), space: "physical" };
    await adapter.executeAction({ type: "click", point: p });
    await sleep(300);
    const r = await adapter.executeAction({ type: "type", text });
    await sleep(Math.min(4000, 600 + text.length * 12)); // long text needs time
    await clickAria("校验");
    await sleep(500);
    const v = await verdictText();
    if (!v.includes("PASS")) throw new Error(v || "no verdict");
    return v.replace("VERDICT: ", "");
  });
}

// X2 scroll precision: 3 rounds
for (let round = 1; round <= 3; round++) {
  await t(`X2 scroll-to-target round ${round}`, async () => {
    await clickAria("出题");
    const arr = await els();
    const sum = (Array.isArray(arr) ? arr : []).find((e) => /滚动汇总:/.test(e.name ?? ""));
    const m = /目标=(\d+)/.exec(sum?.name ?? "");
    if (!m) throw new Error("summary unreadable: " + (sum?.name ?? ""));
    const target = +m[1];
    // scroll: each wheel notch ~ 3 rows (~114px), row height 38px.
    // current top presumably 1 → delta rows = target-1 → notches = ceil((target-1)*38/114)
    const listEl = aria(arr, "滚动列表");
    if (!listEl?.bounds) throw new Error("scroll list not found");
    const px = Math.round(listEl.bounds.x + listEl.bounds.width / 2);
    const py = Math.round(listEl.bounds.y + listEl.bounds.height / 2);
    const pxNeeded = (target - 1) * 38;
    // windows wheel notch = 3 lines * ~13px = ~40px? we'll iterate: scroll, read, correct
    let cur = 1;
    for (let iter = 0; iter < 8; iter++) {
      const arr2 = await els();
      const sum2 = (Array.isArray(arr2) ? arr2 : []).find((e) => /滚动汇总:/.test(e.name ?? ""));
      const mm2 = /首行=(\d+)/.exec(sum2?.name ?? "");
      if (mm2) cur = +mm2[1];
      const delta = (target - 1) * 38 - (cur - 1) * 38;
      if (Math.abs(delta) <= 2 * 38) break;
      const notches = Math.max(1, Math.round(Math.abs(delta) / 100));
      await adapter.executeAction({ type: "scroll", direction: delta > 0 ? "down" : "up", amount: notches, point: { x: px, y: py, space: "physical" } });
      await sleep(600);
    }
    await clickAria("判定滚动");
    await sleep(500);
    const v = await verdictText();
    if (!v.includes("PASS")) throw new Error(v);
    return v.replace("VERDICT: ", "");
  });
}

await b("apps", { mode: "kill", args: { name: "msedge" } });
console.log(`\n===== EXTREME STRESS: ${pass}✓ ${fail}✗ =====`);
process.exit(fail ? 1 : 0);
