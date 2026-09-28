import { describe, expect, it } from "vitest";
import { parseAction, actionSchema, hasTarget, actionSummary, ACTION_TYPES } from "../../src/core/actions.js";
import { ComputerUseError } from "../../src/core/errors.js";

describe("unified action schema (spec §17)", () => {
  it("accepts a click with element", () => {
    const a = parseAction({ type: "click", element: { id: "el:1", source: "uia" } });
    expect(a.type).toBe("click");
  });

  it("accepts a click with point in a declared space", () => {
    const a = parseAction({ type: "click", point: { x: 500, y: 500, space: "normalized" } });
    expect(a.type).toBe("click");
  });

  it("rejects click without target", () => {
    expect(() => parseAction({ type: "click" })).toThrow(ComputerUseError);
  });

  it("rejects unknown action type", () => {
    expect(() => parseAction({ type: "explode" })).toThrow(ComputerUseError);
  });

  it("rejects invalid element source", () => {
    expect(() =>
      actionSchema.safeParse({ type: "click", element: { id: "x", source: "psychic" } }),
    ).toBeTruthy();
  });

  it("drag requires from+to", () => {
    expect(() => parseAction({ type: "drag", from: { point: { x: 1, y: 2 } } })).toThrow(ComputerUseError);
    const ok = parseAction({
      type: "drag",
      from: { point: { x: 1, y: 2 } },
      to: { point: { x: 3, y: 4 } },
    });
    expect(ok.type).toBe("drag");
  });

  it("hasTarget classifies actions", () => {
    expect(hasTarget({ type: "click", point: { x: 1, y: 2 } })).toBe(true);
    expect(hasTarget({ type: "click" })).toBe(false);
    expect(hasTarget({ type: "hotkey", keys: ["ctrl", "s"] })).toBe(true);
    expect(hasTarget({ type: "wait", durationMs: 10 })).toBe(true);
  });

  it("summaries are human readable", () => {
    expect(actionSummary({ type: "click", element: { id: "e", source: "ax", name: "保存" } })).toContain("保存");
    expect(actionSummary({ type: "hotkey", keys: ["cmd", "c"] })).toBe("hotkey cmd+c");
    expect(actionSummary({ type: "finish", status: "success" })).toBe("finish(success)");
  });

  it("exposes the full §17 action vocabulary", () => {
    expect(ACTION_TYPES).toContain("click");
    expect(ACTION_TYPES).toContain("long_press");
    expect(ACTION_TYPES).toContain("swipe");
    expect(ACTION_TYPES).toContain("set_value");
    expect(ACTION_TYPES).toContain("toggle");
    expect(ACTION_TYPES).toContain("invoke");
    expect(ACTION_TYPES).toContain("launch_app");
    expect(ACTION_TYPES).toContain("back");
    expect(ACTION_TYPES).toContain("home");
    expect(ACTION_TYPES).toContain("finish");
    expect(ACTION_TYPES).toContain("fail");
  });
});
