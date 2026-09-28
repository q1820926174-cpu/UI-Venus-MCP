import { describe, expect, it } from "vitest";
import { parsePsJson } from "../../src/platforms/windows/powershell.js";

const r = (stdout: string) => ({ code: 0, stdout, stderr: "" });

describe("parsePsJson (stray-noise tolerant)", () => {
  it("parses clean JSON", () => {
    expect(parsePsJson("x", r('{"ok":true}'))).toEqual({ ok: true });
  });

  it("parses JSON preceded by stray PS output (the runner '1' line)", () => {
    expect(parsePsJson("x", r('1\r\n{"ok":true,"cursor":{"x":200,"y":200}}'))).toEqual({
      ok: true,
      cursor: { x: 200, y: 200 },
    });
    expect(parsePsJson("x", r('noise more noise\n{"ok":true}'))).toEqual({ ok: true });
  });

  it("extracts the LAST balanced object", () => {
    const out = parsePsJson<{ ok: boolean; v: number }>("x", r('{"ok":true}\nlog line\n{"ok":false,"v":7}'));
    expect(out).toEqual({ ok: false, v: 7 });
  });

  it("handles nested braces in strings", () => {
    expect(parsePsJson("x", r('1\n{"ok":true,"msg":"brace } inside"}'))).toEqual({
      ok: true,
      msg: "brace } inside",
    });
  });

  it("still fails honestly on garbage", () => {
    expect(() => parsePsJson("x", r("no json at all"))).toThrow(/not valid JSON/);
    expect(() => parsePsJson("x", r(""))).toThrow();
  });
});
