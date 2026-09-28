/**
 * Verifier unit tests (spec §23): structured assertions first, vision last.
 */
import { describe, expect, it } from "vitest";
import { checkStructuredAssertion, heuristicVerify, Verifier } from "../../src/orchestrator/verifier.js";
import { MockProvider } from "../../src/providers/mock/provider.js";
import type { Observation, UINode } from "../../src/core/types.js";

const tree: UINode = {
  id: "root",
  source: "uia",
  role: "window",
  name: "设置",
  children: [
    { id: "chk", source: "uia", role: "checkbox", name: "自动更新", checked: false, value: "off" },
    { id: "txt", source: "uia", role: "textfield", name: "用户名", value: "alice" },
    { id: "msg", source: "uia", role: "statictext", name: "保存成功" },
  ],
};

const obs = (t: UINode | null = tree, withShot = false): Observation =>
  ({
    target: { id: "x", platform: "macos", type: "local", name: "x" },
    screen: { displays: [], orientation: "landscape", width: 800, height: 600 },
    uiTree: t ?? undefined,
    screenshot: withShot
      ? {
          format: "png",
          dataBase64: "",
          width: 100,
          height: 100,
          scale: 1,
          origin: { x: 0, y: 0 },
          orientation: "landscape",
          capturedAt: 0,
          targetId: "x",
        }
      : undefined,
    capabilities: {} as never,
    capturedAt: 0,
  }) as unknown as Observation;

describe("checkStructuredAssertion", () => {
  it("verifies checked=false deterministically", () => {
    const r = checkStructuredAssertion(obs(), {
      element: { name: "自动更新" },
      property: { checked: false },
    });
    expect(r?.pass).toBe(true);
    expect(r?.source).toBe("structured");
  });

  it("fails checked=true when control is off", () => {
    const r = checkStructuredAssertion(obs(), {
      element: { name: "自动更新" },
      property: { checked: true },
    });
    expect(r?.pass).toBe(false);
  });

  it("verifies valueEquals", () => {
    expect(
      checkStructuredAssertion(obs(), { element: { name: "用户名" }, property: { valueEquals: "alice" } })?.pass,
    ).toBe(true);
    expect(
      checkStructuredAssertion(obs(), { element: { name: "用户名" }, property: { valueEquals: "bob" } })?.pass,
    ).toBe(false);
  });

  it("verifies textVisible across the tree", () => {
    expect(checkStructuredAssertion(obs(), { property: { textVisible: "保存成功" } })?.pass).toBe(true);
    expect(checkStructuredAssertion(obs(), { property: { textVisible: "找不到" } })?.pass).toBe(false);
  });

  it("verifies exists=false", () => {
    expect(
      checkStructuredAssertion(obs(), { element: { name: "不存在" }, property: { exists: false } })?.pass,
    ).toBe(true);
  });

  it("returns null (not false) when the tree is missing → vision decides", () => {
    expect(checkStructuredAssertion(obs(null), { property: { textVisible: "x" } })).toBeNull();
  });
});

describe("heuristicVerify", () => {
  it("verifies 关闭-style goals from toggle state", () => {
    const r = heuristicVerify(obs(), "关闭自动更新");
    expect(r?.pass).toBe(true);
    expect(r?.source).toBe("structured");
  });

  it("fails when the toggle did not move", () => {
    const badTree: UINode = {
      ...tree,
      children: [{ ...tree.children![0]!, checked: true, value: "on" }],
    };
    expect(heuristicVerify(obs(badTree), "关闭自动更新")?.pass).toBe(false);
  });

  it("returns null for goals without toggle verbs", () => {
    expect(heuristicVerify(obs(), "打开设置页面")).toBeNull();
  });
});

describe("Verifier.verifyGoal", () => {
  it("uses structured heuristics without calling the provider", async () => {
    const provider = new MockProvider();
    const v = new Verifier(provider);
    const r = await v.verifyGoal(obs(), "关闭自动更新");
    expect(r.source).toBe("structured");
    expect(provider.calls.verify).toBe(0);
  });

  it("falls back to vision when heuristics are inapplicable", async () => {
    const provider = new MockProvider({
      verify: [{ pass: true, source: "vision", evidence: "screen shows the page", confidence: 0.8, raw: "" }],
    });
    const v = new Verifier(provider);
    const r = await v.verifyGoal(obs(tree, true), "页面已加载");
    expect(r.source).toBe("vision");
    expect(r.pass).toBe(true);
    expect(provider.calls.verify).toBe(1);
  });

  it("fails honestly when neither channel is available", async () => {
    const v = new Verifier(new MockProvider());
    const r = await v.verifyGoal(obs(null, false), "something happened");
    expect(r.pass).toBe(false);
    expect(r.evidence).toContain("no structured signal");
  });
});
