import { describe, expect, it } from "vitest";
import {
  groundingPrompt,
  parseGroundingPoint,
  parseAgentResponse,
  parseActionLine,
  parseVerifyAnswer,
  agentSystemPrompt,
} from "../../src/providers/ui-venus/prompts.js";

describe("UI-Venus prompts & parsing", () => {
  it("grounding prompt matches the official usage", () => {
    const p = groundingPrompt("关闭按钮");
    expect(p).toContain("Output the center point");
    expect(p).toContain("关闭按钮");
    expect(p).toContain("[x,y]");
    expect(p).toContain("[-1,-1]");
  });

  it("parses plain coordinate output (calibrated model behavior)", () => {
    expect(parseGroundingPoint("[676, 680]")).toEqual({ x: 676, y: 680, feasible: true });
  });

  it("parses coordinates wrapped in text", () => {
    expect(parseGroundingPoint('The point is [123, 456].')?.x).toBe(123);
  });

  it("tolerates full-width brackets/commas", () => {
    expect(parseGroundingPoint("【200，300】")).toEqual({ x: 200, y: 300, feasible: true });
  });

  it("marks [-1,-1] as infeasible", () => {
    const r = parseGroundingPoint("[-1,-1]");
    expect(r?.feasible).toBe(false);
  });

  it("returns null for garbage", () => {
    expect(parseGroundingPoint("I cannot see it")).toBeNull();
  });
});

describe("agent decision parsing", () => {
  it("parses UI-TARS style Thought/Action", () => {
    const r = parseAgentResponse("Thought: 需要点击关闭按钮\nAction: click(677, 685)");
    expect(r?.thought).toContain("关闭");
    expect(r?.actionLine).toBe("click(677, 685)");
  });

  it("accepts a bare function call without Thought", () => {
    expect(parseAgentResponse("finished()")?.actionLine).toBe("finished()");
  });

  it("maps action kinds", () => {
    expect(parseActionLine("click(500,500)")).toEqual({ kind: "click", x: 500, y: 500 });
    expect(parseActionLine("left_double(10,20)")).toEqual({ kind: "double_click", x: 10, y: 20 });
    expect(parseActionLine("right_single(1,2)")).toEqual({ kind: "right_click", x: 1, y: 2 });
    expect(parseActionLine("drag(0,0,100,100)")).toEqual({ kind: "drag", from: { x: 0, y: 0 }, to: { x: 100, y: 100 } });
    expect(parseActionLine('type("hello world")')).toEqual({ kind: "type", text: "hello world" });
    expect(parseActionLine("hotkey(ctrl+c)")).toEqual({ kind: "hotkey", keys: ["ctrl", "c"] });
    expect(parseActionLine("hotkey(command+space)")).toEqual({ kind: "hotkey", keys: ["command", "space"] });
    expect(parseActionLine("scroll(500,500,down,3)")).toEqual({ kind: "scroll", x: 500, y: 500, direction: "down", magnitude: 3 });
    expect(parseActionLine("wait()")).toEqual({ kind: "wait" });
    expect(parseActionLine("finished()")).toEqual({ kind: "finished" });
    expect(parseActionLine('fail("not found")')).toEqual({ kind: "fail", reason: "not found" });
  });

  it("survives code fences and trailing prose in the action line", () => {
    expect(parseActionLine("```click(1,2)```")).toEqual({ kind: "click", x: 1, y: 2 });
  });

  it("parses NAMED arguments (observed live from UI-Venus-2-9B-W8A8)", () => {
    expect(parseActionLine("click(x=676, y=683)")).toEqual({ kind: "click", x: 676, y: 683 });
    expect(parseActionLine("click(x = 500,y = 500)")).toEqual({ kind: "click", x: 500, y: 500 });
    expect(parseActionLine('type(content="你好世界")')).toEqual({ kind: "type", text: "你好世界" });
    expect(parseActionLine("hotkey(key=ctrl+c)")).toEqual({ kind: "hotkey", keys: ["ctrl", "c"] });
    expect(parseActionLine('scroll(x=500, y=500, direction="down", magnitude=3)')).toEqual({
      kind: "scroll", x: 500, y: 500, direction: "down", magnitude: 3,
    });
    expect(parseActionLine("drag(x1=0, y1=0, x2=100, y2=100)")).toEqual({
      kind: "drag", from: { x: 0, y: 0 }, to: { x: 100, y: 100 },
    });
    expect(parseActionLine('fail(reason="not found")')).toEqual({ kind: "fail", reason: "not found" });
  });

  it("returns null on malformed lines", () => {
    expect(parseActionLine("clickx(1,2)")).toBeNull();
    expect(parseActionLine("click()")).toBeNull();
  });

  it("system prompt declares normalized coordinates and finished()", () => {
    const p = agentSystemPrompt();
    expect(p).toContain("[0,1000]");
    expect(p).toContain("finished()");
    expect(p).toContain("hotkey(");
  });
});

describe("verify answer parsing", () => {
  it("parses the JSON contract", () => {
    expect(parseVerifyAnswer('{"pass": true, "evidence": "toggle is off"}')).toEqual({
      pass: true,
      evidence: "toggle is off",
    });
  });

  it("parses JSON embedded in prose", () => {
    expect(parseVerifyAnswer('Result: {"pass": false, "evidence": "still on"} — done')?.pass).toBe(false);
  });

  it("falls back to yes/no detection", () => {
    expect(parseVerifyAnswer("Yes, the setting is off.")?.pass).toBe(true);
    expect(parseVerifyAnswer("No, the checkbox is still checked.")?.pass).toBe(false);
  });

  it("returns null when ambiguous", () => {
    expect(parseVerifyAnswer("maybe?")).toBeNull();
  });
});
