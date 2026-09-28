import { describe, expect, it } from "vitest";
import { parseDsl, validateDsl, serializeDsl, recordToScript } from "../../src/scripting/dsl.js";
import type { RecordEntry } from "../../src/recorder/recorder.js";

const validYaml = `
name: disable-auto-update
description: 关闭自动更新并保存
target:
  type: local
  platform: macos
  app: GoldAgent
steps:
  - locate:
      role: button
      name: 设置
    action: click
  - wait:
      durationMs: 500
  - locate:
      name: 自动更新
    action: toggle
    value: false
  - locate:
      role: button
      name: 保存
    action: click
assert:
  - element:
      name: 自动更新
    property:
      checked: false
`;

describe("automation DSL (spec §26)", () => {
  it("parses the spec example shape", () => {
    const s = parseDsl(validYaml);
    expect(s.name).toBe("disable-auto-update");
    expect(s.steps).toHaveLength(4);
    expect(s.steps[0]!.locate!.name).toBe("设置");
    expect(s.steps[2]!.action).toBe("toggle");
    expect(s.assert![0]!.property.checked).toBe(false);
  });

  it("rejects missing name/steps", () => {
    expect(() => validateDsl({ steps: [] })).toThrow(/name/);
    expect(() => validateDsl({ name: "x" })).toThrow(/steps/);
    expect(() => validateDsl({ name: "x", steps: [] })).toThrow(/non-empty/);
  });

  it("rejects unknown actions with a helpful list", () => {
    try {
      validateDsl({ name: "x", steps: [{ action: "teleport" }] });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("teleport");
      expect((e as Error).message).toContain("click");
    }
  });

  it("round-trips through YAML", () => {
    const s = parseDsl(validYaml);
    const text = serializeDsl(s);
    const s2 = parseDsl(text);
    expect(s2.name).toBe(s.name);
    expect(s2.steps).toHaveLength(s.steps.length);
  });

  it("recordToScript emits semantic locators, not coordinates (spec §25)", () => {
    const entries: RecordEntry[] = [
      {
        timestamp: 1,
        platform: "macos",
        actionSummary: 'click "设置"',
        ok: true,
        method: "semantic",
        action: { type: "click", element: { id: "ax:window[1]/2", source: "ax", role: "button", name: "设置" } },
      },
      {
        timestamp: 2,
        platform: "macos",
        actionSummary: "click @(432,621)",
        ok: true,
        method: "coordinate",
        action: { type: "click", point: { x: 432, y: 621, space: "screenshot" } },
      },
      {
        timestamp: 3,
        platform: "macos",
        actionSummary: "type",
        ok: true,
        method: "semantic",
        action: { type: "type", text: "hello", element: { id: "dom:input-q", source: "dom", role: "searchbox" } },
      },
      {
        timestamp: 4,
        platform: "macos",
        actionSummary: "click broken",
        ok: false,
        method: "coordinate",
        action: { type: "click", point: { x: 1, y: 1, space: "screenshot" } },
      },
    ];
    const script = recordToScript(entries, { name: "recorded", target: { type: "local", platform: "macos" } as never });
    expect(script.steps).toHaveLength(3); // failed attempt excluded
    expect(script.steps[0]!.locate!.name).toBe("设置");
    // coordinate step carries an explicit fragility marker, not a silent click(432,621)
    expect(script.steps[1]!.description).toContain("坐标步骤");
    expect(script.steps[2]!.text).toBe("hello");
  });
});
