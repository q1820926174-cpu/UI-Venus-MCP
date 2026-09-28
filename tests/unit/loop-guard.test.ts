import { describe, expect, it } from "vitest";
import { LoopGuard } from "../../src/orchestrator/loop-guard.js";

/** flip n hex digits (4 bits each) of a hash for controlled hamming distances. */
function flip(hash: string, bits: number): string {
  const digits = Math.ceil(bits / 4);
  const arr = [...hash];
  for (let i = 0; i < digits && i < arr.length; i++) {
    const v = parseInt(arr[i]!, 16);
    arr[i] = ((v ^ 0xf) & 0xf).toString(16);
  }
  return arr.join("");
}

describe("loop guard (spec §32)", () => {
  const guard = () => new LoopGuard({ maxStagnation: 3, sameScreenDistance: 4, maxRepeatedFailures: 3 });

  it("passes healthy varied steps", () => {
    const g = guard();
    const h1 = "a".repeat(64);
    const h2 = flip(h1, 80); // far apart (80 bits of 256)
    const h3 = flip(h1, 160);
    g.record({ index: 1, actionType: "click", actionSummary: "click a", elementId: "a", screenHash: h1, ok: true });
    g.record({ index: 2, actionType: "type", actionSummary: 'type "x"', screenHash: h2, ok: true });
    g.record({ index: 3, actionType: "click", actionSummary: "click b", elementId: "b", screenHash: h3, ok: true });
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
    const base = "5".repeat(64);
    // hashes differing by 1 bit → same screen
    g.record({ index: 1, actionType: "click", actionSummary: "click a", elementId: "a", screenHash: base, ok: true });
    g.record({ index: 2, actionType: "click", actionSummary: "click a", elementId: "a", screenHash: flip(base, 1), ok: true });
    g.record({ index: 3, actionType: "click", actionSummary: "click a", elementId: "a", screenHash: flip(base, 200), ok: true });
    // third hash is far away → breaks the identical streak
    expect(g.evaluate().stagnant).toBe(false);
  });
});
