/**
 * REAL end-to-end delegate E2E on macOS with the LIVE UI-Venus endpoint:
 * launch Calculator → autonomous loop (official protocol) clicks 7 →
 * per-step verification confirms → SUCCESS. Ground truth is read from
 * the Calculator display via the AX tree.
 *
 * Opt-in: RUN_MACOS_E2E=1 RUN_VENUS_LIVE=1 npx vitest run tests/e2e/macos-delegate-live.test.ts
 * Requires Screen Recording + Accessibility permissions.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { MacosAdapter } from "../../src/platforms/macos/adapter.js";
import { UiVenusProvider } from "../../src/providers/ui-venus/provider.js";
import { loadConfig } from "../../src/config.js";
import { PlatformRouter, type AdapterRegistration } from "../../src/platforms/router.js";
import { TaskOrchestrator } from "../../src/orchestrator/executor.js";
import { readAxTree } from "../../src/platforms/macos/axtree.js";

const enabled = !!process.env.RUN_MACOS_E2E && !!process.env.RUN_VENUS_LIVE;

describe.skipIf(!enabled)("macOS delegate E2E — Calculator × live UI-Venus (official protocol)", () => {
  let adapter: MacosAdapter;
  let orch: TaskOrchestrator;

  beforeAll(() => {
    adapter = new MacosAdapter({ screenshot: { maxDimension: 1920 }, axTree: { maxDepth: 10, maxNodes: 250 } });
    const router = new PlatformRouter();
    router.register({ platform: "macos", factory: async () => adapter, probe: async () => ({ available: true }) } as AdapterRegistration);
    const cfg = loadConfig();
    orch = new TaskOrchestrator(router, new UiVenusProvider(cfg.venus), cfg);
  }, 60_000);

  afterAll(async () => {
    await adapter?.terminateApp("Calculator").catch(() => {});
  });

  it(
    "autonomously clicks 7 in Calculator and finishes with verification",
    { timeout: 300_000 },
    async () => {
      // clean state: kill any stale instance, then launch + focus
      await adapter.terminateApp("Calculator").catch(() => {});
      await new Promise((r) => setTimeout(r, 600));
      await adapter.launchApp("Calculator");
      await new Promise((r) => setTimeout(r, 2500));
      await adapter.focusTarget({ app: "Calculator" });

      const record = await orch.executeTask({
        target: { type: "local", platform: "macos" },
        goal: "在计算器中点击数字 7",
        mode: "delegate",
        maxSteps: 8,
        language: "zh",
        wait: true,
      });

      // ground truth from the AX tree display element
      const els = await readAxTree({ processName: "Calculator", maxDepth: 8, maxNodes: 120 });
      const display = els.find(
        (e) => (e.role === "AXStaticText" || e.role === "AXTextField") && /[\d.,]/.test((e.value || e.name || "").trim()),
      );
      const displayText = (display?.value ?? display?.name ?? "").replace(/[\u200e\u200f]/g, "").trim();

      console.log("outcome :", record.outcome?.status, "|", record.outcome?.reason ?? record.outcome?.evidence);
      console.log("steps   :", record.steps.map((s) => `${s.summary}${s.ok ? "" : "✗"}`).join(" | "));
      console.log("display :", JSON.stringify(displayText));

      expect(record.outcome?.status).toBe("SUCCESS");
      // the 7 button was actually pressed (display contains at least one 7)
      expect(displayText).toMatch(/7/);
      // and at least one click step executed
      expect(record.steps.some((s) => s.action.type === "click" && s.ok)).toBe(true);
    },
  );
});
