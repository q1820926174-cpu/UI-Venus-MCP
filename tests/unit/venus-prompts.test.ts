import { describe, expect, it } from "vitest";
import {
  groundingPrompt,
  parseGroundingPoint,
  parseOfficialResponse,
  parseActionCall,
  parseVerifyAnswer,
  computerSystemPrompt,
  normalizedPoint999,
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

describe("official Computer action protocol", () => {
  it("parses <think>/<action> blocks", () => {
    const r = parseOfficialResponse(
      "<think>需要点击关闭按钮</think>\n<action>Click(box=(677, 685))</action>",
    );
    expect(r.thought).toContain("关闭");
    expect(r.actionText).toBe("Click(box=(677, 685))");
  });

  it("uses reasoning_content as thought when no <think> tag", () => {
    const r = parseOfficialResponse("<action>Wait()</action>", "step-by-step reasoning");
    expect(r.thought).toBe("step-by-step reasoning");
    expect(r.actionText).toBe("Wait()");
  });

  it("accepts a bare action without tags", () => {
    expect(parseOfficialResponse("Finished()").actionText).toBe("Finished()");
  });

  it("rejects malformed/multiple action blocks", () => {
    expect(() => parseOfficialResponse("<action>A()</action><action>B()</action>")).toThrow(/exactly one/);
    expect(() => parseOfficialResponse("<action A()</action>")).toThrow(/malformed/);
  });

  it("parses the full official action grammar", () => {
    expect(parseActionCall("Click(box=(500, 500))").args.box).toEqual([500, 500]);
    expect(parseActionCall("Click()").args).toEqual({});
    expect(parseActionCall("DoubleClick(box=(10, 20))").name).toBe("DoubleClick");
    expect(parseActionCall("RightClick(box=(1, 2))").name).toBe("RightClick");
    expect(parseActionCall("Hover(box=(5, 5))").name).toBe("Hover");
    expect(parseActionCall("Drag(end=(100, 100), start=(0, 0))").args.end).toEqual([100, 100]);
    expect(parseActionCall("Swipe(amount=-5, axis='vertical')").args.amount).toBe(-5);
    expect(parseActionCall("Type(content='hello world')").args.content).toBe("hello world");
    expect(parseActionCall("Type(content='query\\n')").args.content).toBe("query\n");
    expect(parseActionCall("Hotkey(keys=['ctrl', 'c'])").args.keys).toEqual(["ctrl", "c"]);
    expect(parseActionCall("Hotkey(keys=['down'], repeat=5)").args.repeat).toBe(5);
    expect(parseActionCall("Wait()").name).toBe("Wait");
    expect(parseActionCall("Finished(content='done')").name).toBe("Finished");
    expect(parseActionCall("CallUser(content='need help')").name).toBe("CallUser");
  });

  it("parses Sequence with children", () => {
    const call = parseActionCall("Sequence(actions=[Click(box=(1, 2)), Hotkey(keys=['ctrl', 's'])])");
    expect(call.name).toBe("Sequence");
    expect(call.children).toHaveLength(2);
    expect(call.children![0]!.name).toBe("Click");
  });

  it("rejects unsafe/invalid actions like the official AST parser", () => {
    expect(() => parseActionCall("click(1, 2)")).toThrow(); // positional args not allowed
    expect(() => parseActionCall("Import('os').system('rm -rf /')")).toThrow();
    expect(() => parseActionCall("__import__('os')")).toThrow();
    expect(() => parseActionCall("Sequence(actions=[Click(box=(1, 2))])")).toThrow(/2-32/); // too few children
    expect(() => parseActionCall("Teleport(box=(1, 2))")).toThrow(/unsupported/);
    expect(() => parseActionCall("Click(box=(1, 2, 3))")).toThrow(/two-number tuple/);
    expect(() => parseActionCall("Click(box=(1000, 500))")).toThrow(/\[0, 999\]/);
    expect(() => parseActionCall("Swipe(amount=1, axis='diagonal')")).toThrow(/axis/);
  });

  it("official /999 coordinate conversion, clamped to image bounds", () => {
    expect(normalizedPoint999([0, 0], 1920, 1080)).toEqual({ x: 0, y: 0 });
    expect(normalizedPoint999([999, 999], 1920, 1080)).toEqual({ x: 1919, y: 1079 });
    // 677/999 * 1920 = 1301.1 → 1301 (the calibrated CLOSE button)
    expect(normalizedPoint999([677, 685], 1920, 1080).x).toBe(1301);
    expect(normalizedPoint999([685, 685], 1920, 1080).y).toBeCloseTo(740, 0);
  });

  it("official system prompt carries the task and action space", () => {
    const p = computerSystemPrompt("打开设置", "(not provided)");
    expect(p).toContain("打开设置");
    expect(p).toContain("Click(box=(x1, y1))");
    expect(p).toContain("Finished");
    expect(p).toContain("<think>");
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
