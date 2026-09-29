/**
 * Locator fusion unit tests (spec §4/§21): structured-first, vision
 * fallback, point→element snapping.
 */
import { describe, expect, it } from "vitest";
import {
  matchStructured,
  nameTokens,
  roleFromInstruction,
  snapToStructuredElement,
} from "../../src/orchestrator/locator.js";
import type { Observation, UINode } from "../../src/core/types.js";

const tree: UINode = {
  id: "root",
  source: "uia",
  role: "window",
  name: "设置",
  children: [
    { id: "a", source: "uia", role: "button", name: "关闭按钮", bounds: { x: 600, y: 40, width: 120, height: 40 }, clickable: true },
    { id: "b", source: "uia", role: "checkbox", name: "自动更新", checked: true, value: "on", bounds: { x: 40, y: 140, width: 220, height: 32 } },
    { id: "c", source: "uia", role: "textfield", name: "搜索", bounds: { x: 40, y: 220, width: 400, height: 40 }, editable: true },
  ],
};

const obs = (t: UINode | null): Observation =>
  ({
    target: { id: "x", platform: "macos", type: "local", name: "x" },
    screen: { displays: [], orientation: "landscape", width: 800, height: 600 },
    uiTree: t ?? undefined,
    capabilities: {} as never,
    capturedAt: 0,
  }) as unknown as Observation;

describe("nameTokens / roleFromInstruction", () => {
  it("tokenizes CJK and latin", () => {
    expect(nameTokens("关闭按钮")).toEqual(["关闭按钮"]);
    expect(nameTokens("the login button")).toContain("login");
  });

  it("extracts roles from NL", () => {
    expect(roleFromInstruction("勾选复选框")).toBe("checkbox");
    expect(roleFromInstruction("click the button")).toBe("button");
    expect(roleFromInstruction("搜索输入框")).toBe("textfield");
    expect(roleFromInstruction("设置")).toBeUndefined();
  });
});

describe("matchStructured", () => {
  it("finds elements by name containment", () => {
    const el = matchStructured(obs(tree), "关闭按钮");
    expect(el?.id).toBe("a");
  });

  it("prefers role matches", () => {
    // "更新" appears only in the checkbox name
    const el = matchStructured(obs(tree), "自动更新", "checkbox");
    expect(el?.id).toBe("b");
  });

  it("returns null when nothing matches", () => {
    expect(matchStructured(obs(tree), "不存在的控件")).toBeNull();
  });

  it("returns null without a tree", () => {
    expect(matchStructured(obs(null), "关闭按钮")).toBeNull();
  });
});

describe("snapToStructuredElement (vision→semantic fusion)", () => {
  it("snaps a vision point inside element bounds", () => {
    const el = snapToStructuredElement(obs(tree), { x: 650, y: 55 });
    expect(el?.id).toBe("a");
  });

  it("snaps within tolerance of center", () => {
    const el = snapToStructuredElement(obs(tree), { x: 620, y: 62 });
    expect(el?.id).toBe("a");
  });

  it("refuses distant points (keep vision coordinates)", () => {
    expect(snapToStructuredElement(obs(tree), { x: 790, y: 590 })).toBeNull();
  });

  it("NEVER snaps onto static labels even when the point is inside them", () => {
    const labelTree: UINode = {
      id: "l1", source: "uia", role: "text", name: "T1 账户表单链（依次完成才解锁登录）",
      bounds: { x: 0, y: 0, width: 400, height: 40 }, clickable: false,
      children: [
        { id: "e1", source: "uia", role: "edit", name: "用户名输入", bounds: { x: 0, y: 50, width: 200, height: 30 }, editable: true },
      ],
    };
    const t = obs(labelTree);
    // point inside the big label → must NOT return the label
    const snapped = snapToStructuredElement(t, { x: 200, y: 20 });
    expect(snapped?.id).not.toBe("l1");
    // point inside the small edit → snaps to the edit
    expect(snapToStructuredElement(t, { x: 100, y: 65 })?.id).toBe("e1");
  });
});
