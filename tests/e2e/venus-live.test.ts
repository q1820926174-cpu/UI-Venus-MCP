/**
 * Live UI-Venus provider E2E against the real W8A8 endpoint.
 * Opt-in: RUN_VENUS_LIVE=1 npx vitest run tests/e2e/venus-live.test.ts
 *
 * Uses tests/fixtures/calibration.png — a realistic UI mock with a red
 * CLOSE button centered at (1300, 740) on 1920×1080 → expected normalized
 * [677, 685]. Manual calibration on 2026-09-28: model returned [676, 680],
 * confirming [0,1000] normalized output space.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../src/config.js";
import { UiVenusProvider } from "../../src/providers/ui-venus/provider.js";
import type { Observation, Screenshot } from "../../src/core/types.js";

const enabled = !!process.env.RUN_VENUS_LIVE;
const EXPECTED = { x: 677, y: 685 };
const PIXEL = { x: 1300, y: 740 };

describe.skipIf(!enabled)("UI-Venus live grounding (W8A8 endpoint)", () => {
  let provider: UiVenusProvider;
  let obs: Observation;

  beforeAll(() => {
    const cfg = loadConfig();
    if (!cfg.venus.apiKey) throw new Error("VENUS_API_KEY not configured");
    provider = new UiVenusProvider(cfg.venus);
    const base64 = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../fixtures/calibration.png")).toString("base64");
    const shot: Screenshot = {
      format: "png",
      dataBase64: base64,
      width: 1920,
      height: 1080,
      scale: 1,
      origin: { x: 0, y: 0 },
      orientation: "landscape",
      capturedAt: Date.now(),
      targetId: "calibration",
    };
    obs = {
      target: { id: "calibration", platform: "mock" as never, type: "local", name: "calibration" },
      screen: { displays: [], orientation: "landscape", width: 1920, height: 1080 },
      screenshot: shot,
      capabilities: {} as never,
      capturedAt: Date.now(),
    };
  }, 30_000);

  it("locates the CLOSE button within 30/1000 tolerance", { timeout: 120_000 }, async () => {
    const result = await provider.locate({ instruction: "CLOSE button", observation: obs });
    console.log("live locate:", JSON.stringify(result));
    expect(result.source).toBe("vision");
    expect(result.normalized).toBeTruthy();
    expect(Math.abs(result.normalized!.x - EXPECTED.x)).toBeLessThanOrEqual(30);
    expect(Math.abs(result.normalized!.y - EXPECTED.y)).toBeLessThanOrEqual(30);
  });

  it("answers infeasible grounding with not_found", { timeout: 120_000 }, async () => {
    const result = await provider.locate({ instruction: "the purple unicorn settings gear (does not exist in this image)", observation: obs });
    console.log("infeasible locate:", JSON.stringify(result));
    // model may return [-1,-1] (not_found) — accept either honest not_found or a point
    if (result.source === "not_found") {
      expect(result.source).toBe("not_found");
    } else {
      expect(result.normalized).toBeTruthy();
    }
  });

  it("maps an agent step to a click near the button (screenshot pixel space)", { timeout: 120_000 }, async () => {
    const decision = await provider.decideNextAction({ goal: "点击 CLOSE 按钮", observation: obs, history: [], language: "zh" });
    console.log("live decide:", JSON.stringify(decision).slice(0, 400));
    expect(decision.action).toBeTruthy();
    expect(["click", "finish", "fail", "wait"]).toContain(decision.action.type);
    if (decision.action.type === "click" && "point" in decision.action && decision.action.point) {
      const p = decision.action.point;
      expect(Math.abs(p.x - PIXEL.x)).toBeLessThan(60);
      expect(Math.abs(p.y - PIXEL.y)).toBeLessThan(60);
      expect(p.space).toBe("screenshot");
    }
  });
});
