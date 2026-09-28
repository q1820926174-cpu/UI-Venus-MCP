import { describe, expect, it } from "vitest";
import { LoopGuard } from "../../src/orchestrator/loop-guard.js";

describe("loop guard (spec §32)", () => {
  const guard = () => new LoopGuard({ maxStagnation: 3, sameScreenDistance: 4, maxRepeatedFailures: 3 });

  it("passes healthy varied steps", () => {
    const g = guard();
    g.record({ index: 1, actionType: "click", actionSummary: "click a", elementId: "a", screenHash: "ff", ok: true });
    g.record({ index: 2, actionType: "type", actionSummary: 'type "x"', screenHash: "0f", ok: true });
    g.record({ index: 3, actionType: "click", actionSummary: "click b", elementId: "b", screenHash: "33", ok: true });
    expect(g.evaluate().stagnant).toBe(false);
  });

  it("detects identical action+element+screen loops", () => {
    const g = guard();
    const step = { actionType: "click", actionSummary: "click a", elementId: "a", screenHash: "ff", ok: true };
    g.record({ index: 1, ...step });
    g.record({ index: 2, ...step });
    expect(g.evaluate().stagnant).toBe(false); // below threshold
    g.record({ index: 3, ...step });
    const v = g.evaluate();
    expect(v.stagnant).toBe(true);
    expect(v.recovery).toBe("alternate-strategy");
    g.record({ index: 4, ...step });
    expect(g.evaluate().recovery).toBe("give-up");
  });

  it("detects repeated identical failures", () => {
    const g = guard();
    for (let i = 1; i <= 3; i++) {
      g.record({ index: i, actionType: "click", actionSummary: "click x", elementId: "x", ok: false });
    }
    const v = g.evaluate();
    expect(v.stagnant).toBe(true);
    expect(v.reasons.join(" ")).toContain("failed 3×");
  });

  it("perceptual hash distance defines same-screen", () => {
    const g = guard();
    // hashes differing by 1 bit → same screen
    g.record({ index: 1, actionType: "click", actionSummary: "click a", elementId: "a", screenHash: "000000000000000f", ok: true });
    g.record({ index: 2, actionType: "click", actionSummary: "click a", elementId: "a", screenHash: "0000000000000000", ok: true });
    g.record({ index: 3, actionType: "click", actionSummary: "click a", elementId: "a", screenHash: "ffffffffffffffff", ok: true });
    // third hash is completely different → breaks the streak
    expect(g.evaluate().stagnant).toBe(false);
  });
});
