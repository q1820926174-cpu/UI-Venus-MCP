/**
 * REAL Linux E2E on a GitHub Actions ubuntu-latest runner (free test
 * machine) with a genuine X session: Xvfb :99 + a window manager-less
 * desktop, xclock/xterm as real GUI targets.
 *
 * Hard assertions: window enumeration (wmctrl), real screenshot via the
 * adapter's probed tool (import/scrot), xdotool mouse move with position
 * read-back. Soft (reported): AT-SPI tree (needs an accessibility bus).
 *
 * Workflow prerequisites (apt): xvfb x11-apps x11-utils xdotool wmctrl
 * imagemagick; DISPLAY=:99 with Xvfb started by the job.
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { buildContext } = await import(join(root, "dist/context.js"));

const report = { startedAt: new Date().toISOString(), display: process.env.DISPLAY };
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
const session = await ctx.router.getSession({ type: "local", platform: "linux" });
const adapter = session.adapter;
hard("open-capabilities", session.info.platform === "linux", adapter.getCapabilities());

// ---- windows enumeration (wmctrl) — xclock/xclock should be listed
const windows = await adapter.listWindows().catch((e) => { log("listWindows error:", e.message); return []; });
hard("wmctrl-windows", windows.length > 0, windows.map((w) => w.title).slice(0, 6));

// ---- real screenshot through the probed capture tool
try {
  const shot = await adapter.screenshot();
  const real = shot.dataBase64.length > 3000;
  hard("capture-real", real, { w: shot.width, h: shot.height, kb: Math.round(shot.dataBase64.length / 1024) });
  writeFileSync(join(root, "ci-linux-shot.png"), Buffer.from(shot.dataBase64, "base64"));
} catch (e) {
  hard("capture-real", false, e.message.slice(0, 140));
}

// ---- xdotool input with position read-back (hard when globalInput)
const caps = adapter.getCapabilities();
if (caps.globalInput) {
  const before = await import("node:child_process").then(({ execFile }) =>
    new Promise((res) => execFile("xdotool", ["getmouselocation"], (e, o) => res((o ?? "").toString().trim())))
  );
  const mv = await adapter.executeAction({ type: "move", point: { x: 320, y: 240, space: "screenshot" } });
  const after = await import("node:child_process").then(({ execFile }) =>
    new Promise((res) => execFile("xdotool", ["getmouselocation"], (e, o) => res((o ?? "").toString().trim())))
  );
  const ok = mv.ok && after.includes("320") && after.includes("240");
  hard("xdotool-move-readback", ok, { before, after, error: mv.error?.message });
} else {
  soft("xdotool-move-readback", false, `globalInput=false: ${(caps.notes ?? []).join("; ").slice(0, 100)}`);
}

// ---- AT-SPI tree (soft — needs an a11y bus the runner doesn't start)
const obs = await adapter.observe({ includeScreenshot: false, includeUITree: true }).catch((e) => null);
soft("atspi-tree", !!obs?.uiTree, obs?.uiTree ? { root: obs.uiTree.role } : "no a11y bus on runner (expected)");

report.finishedAt = new Date().toISOString();
writeFileSync(join(root, "ci-linux-report.json"), JSON.stringify(report, null, 2));
log(report.failed ? `FAILED steps: ${report.failed}` : "ALL HARD STEPS PASSED");
process.exit(report.failed ? 1 : 0);
