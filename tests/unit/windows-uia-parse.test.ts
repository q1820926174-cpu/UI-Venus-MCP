/**
 * Unit tests for the Windows UIA bridge parsing / tree-building / locate logic.
 *
 * These are PURE TypeScript functions fed with recorded raw PowerShell
 * output (tests/unit/windows-uia-parse.fixture.json) — no Windows required.
 */
import { readFileSync } from "node:fs";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildUiForest,
  buildUiTree,
  centerOf,
  elementToNode,
  elementToRef,
  findByRuntimeId,
  isClickable,
  isEditable,
  locateInElements,
  normalizeRole,
  parseUiTreeJson,
  readUiTree,
} from "../../src/platforms/windows/ui-tree.js";
import { failFromPs, parsePsJson } from "../../src/platforms/windows/powershell.js";
import { ComputerUseError } from "../../src/core/errors.js";

const fixture = JSON.parse(
  readFileSync(new URL("./windows-uia-parse.fixture.json", import.meta.url), "utf8"),
) as { notepad: string; desktop: string; quirks: string; forest: string };

describe("parseUiTreeJson (raw PowerShell stdout -> UiaElementJson[])", () => {
  it("parses a real-shaped notepad tree with runtime ids, roles, bounds, patterns", () => {
    const els = parseUiTreeJson(fixture.notepad);
    expect(els).toHaveLength(9);

    const win = els[0]!;
    expect(win.runtimeId).toBe("2,76898,131088");
    expect(win.role).toBe("ControlType.Window");
    expect(win.name).toBe("Untitled - Notepad");
    expect(win.enabled).toBe(true);
    expect(win.bounds).toEqual({ x: 12, y: 8, width: 1010, height: 620 });
    expect(win.patterns).toEqual(["Window", "LegacyIAccessible", "Dock"]);
    expect(win.depth).toBe(0);
    expect(win.pid).toBe(12345);
    expect(win.className).toBe("Notepad");
  });

  it("decodes Windows PowerShell 5.1 \\uXXXX escapes (< > & ') and UTF-8", () => {
    const els = parseUiTreeJson(fixture.notepad);
    const doc = els.find((e) => e.role === "ControlType.Document")!;
    expect(doc.value).toBe("Hello, 世界!<b>");
    const pane = els.find((e) => e.role === "ControlType.Pane")!;
    expect(pane.name).toBe("App 'Title'>X&Co");
  });

  it("tolerates trailing newlines/CRLF around the payload", () => {
    expect(parseUiTreeJson(fixture.notepad + "\r\n")).toHaveLength(9);
    expect(parseUiTreeJson("\n")).toEqual([]);
    expect(parseUiTreeJson("")).toEqual([]);
  });

  it("sanitizes quirks: empty runtimeId dropped, non-array patterns, zero bounds -> null, missing enabled -> true", () => {
    const els = parseUiTreeJson(fixture.quirks);
    // the entry with runtimeId "" is skipped (never fake an unaddressable element)
    expect(els.map((e) => e.runtimeId)).toEqual(["2,1,1", "2,1,2", "2,1,3"]);
    expect(els[0]!.patterns).toEqual([]); // "Invoke" string -> []
    expect(els[1]!.bounds).toBeNull(); // zero-size bounds -> null
    expect(els[1]!.enabled).toBe(true); // missing -> true
    expect(els[2]!.role).toBe("7"); // non-string role passes through as string
  });

  it("throws typed ComputerUseError on invalid JSON / non-array payloads", () => {
    expect(() => parseUiTreeJson("not json at all")).toThrow(ComputerUseError);
    expect(() => parseUiTreeJson('{"error":"PROCESS_NOT_FOUND"}')).toThrow(ComputerUseError);
    try {
      parseUiTreeJson("{broken");
      expect.unreachable();
    } catch (e) {
      expect((e as ComputerUseError).code).toBe("internal_error");
    }
  });
});

describe("normalizeRole", () => {
  it("strips the ControlType prefix and lowercases", () => {
    expect(normalizeRole("ControlType.Button")).toBe("button");
    expect(normalizeRole("ControlType.Document")).toBe("document");
    expect(normalizeRole("ControlType.Edit")).toBe("edit");
  });

  it("falls back to unknown for empty input", () => {
    expect(normalizeRole("")).toBe("unknown");
    expect(normalizeRole("ControlType.")).toBe("unknown");
  });
});

describe("buildUiTree / buildUiForest (depth-stack hierarchy rebuild)", () => {
  it("rebuilds the notepad hierarchy from the flat DFS list", () => {
    const root = buildUiTree(parseUiTreeJson(fixture.notepad));
    expect(root).not.toBeNull();
    expect(root!.id).toBe("uia:2,76898,131088");
    expect(root!.role).toBe("window");
    const childRoles = (root!.children ?? []).map((c) => c.role);
    expect(childRoles).toEqual(["menubar", "document", "button"]);
    // depth-2 MenuItems nest under the MenuBar (their depth sibling, not the document)
    const menubar = root!.children!.find((c) => c.role === "menubar")!;
    expect((menubar.children ?? []).map((c) => c.name)).toEqual(["File", "Edit"]);
  });

  it("produces one root per depth-0 element (multiple windows)", () => {
    const forest = buildUiForest(parseUiTreeJson(fixture.forest));
    expect(forest).toHaveLength(2);
    expect(forest[0]!.name).toBe("Window A");
    expect(forest[1]!.name).toBe("Window B");
  });

  it("wraps a desktop-root walk (depth 0 root, windows at depth 1)", () => {
    const root = buildUiTree(parseUiTreeJson(fixture.desktop))!;
    expect(root!.role).toBe("pane");
    expect(root!.bounds).toEqual({ x: -1920, y: 0, width: 5760, height: 1080 });
    expect((root!.children ?? []).map((c) => c.role)).toEqual(["window", "window", "window"]);
  });

  it("returns null for an empty element list", () => {
    expect(buildUiTree([])).toBeNull();
    expect(buildUiForest([])).toEqual([]);
  });
});

describe("findByRuntimeId (addressing elements for semantic actions)", () => {
  const els = parseUiTreeJson(fixture.notepad);

  it("finds by joined RuntimeId and accepts the uia: prefix", () => {
    expect(findByRuntimeId(els, "2,76898,131108")!.name).toBe("Close");
    expect(findByRuntimeId(els, "uia:2,76898,131108")!.name).toBe("Close");
  });

  it("returns undefined for stale runtime ids", () => {
    expect(findByRuntimeId(els, "2,76898,999999")).toBeUndefined();
  });
});

describe("locateInElements (pure locate() matching)", () => {
  const els = parseUiTreeJson(fixture.notepad);

  it("matches by case-insensitive name substring in both directions", () => {
    expect(locateInElements(els, { name: "close" })!.runtimeId).toBe("2,76898,131108");
    expect(locateInElements(els, { text: "UNTITLED" })!.runtimeId).toBe("2,76898,131088");
  });

  it("combines role + name", () => {
    const hit = locateInElements(els, { role: "Document", name: "editor" });
    expect(hit!.runtimeId).toBe("2,76898,131106");
    expect(locateInElements(els, { role: "Button", name: "editor" })).toBeNull();
  });

  it("supports index selection and resourceId (AutomationId)", () => {
    const items = els.filter((e) => e.role === "ControlType.MenuItem");
    expect(items).toHaveLength(2);
    expect(locateInElements(els, { role: "menuitem", index: 1 })!.name).toBe("Edit");
    expect(locateInElements(els, { resourceId: "MenuBarItem_File" })!.name).toBe("File");
  });

  it("returns null when nothing matches or no criterion given", () => {
    expect(locateInElements(els, { name: "does-not-exist" })).toBeNull();
    expect(locateInElements(els, {})).toBeNull();
  });
});

describe("elementToRef / elementToNode / clickable+editable inference", () => {
  const els = parseUiTreeJson(fixture.notepad);

  it("builds adapter-native refs with uia:<runtimeId> ids", () => {
    const btn = elementToRef(findByRuntimeId(els, "2,76898,131108")!);
    expect(btn.id).toBe("uia:2,76898,131108");
    expect(btn.source).toBe("uia");
    expect(btn.role).toBe("button");
    expect(btn.name).toBe("Close");
    expect(btn.clickable).toBe(true);
    expect(btn.editable).toBe(false);
    expect(btn.bounds).toEqual({ x: 976, y: 10, width: 40, height: 24 });
    expect(btn.attributes?.patterns).toBe("Invoke|LegacyIAccessible");
    expect(btn.attributes?.pid).toBe(12345);
  });

  it("marks Value-pattern documents/edits editable but panes not", () => {
    const doc = findByRuntimeId(els, "2,76898,131106")!;
    expect(isEditable(doc)).toBe(true);
    const pane = findByRuntimeId(els, "2,76898,131114")!;
    expect(isEditable(pane)).toBe(false);
    // no Value pattern -> not editable even for edit roles
    expect(isEditable({ ...findByRuntimeId(els, "2,76898,131112")!, patterns: [] })).toBe(false);
  });

  it("keeps disabled state and physical-pixel bounds untouched", () => {
    const search = elementToNode(findByRuntimeId(els, "2,76898,131112")!);
    expect(search.enabled).toBe(false);
    expect(search.bounds).toEqual({ x: 300, y: 40, width: 200, height: 24 });
  });

  it("considers Toggle/SelectionItem elements clickable even without Invoke", () => {
    const cb = findByRuntimeId(els, "2,76898,131110")!;
    expect(isClickable(cb)).toBe(true); // Toggle pattern
  });
});

describe("centerOf (coordinate fallback math)", () => {
  it("returns the physical-pixel center", () => {
    expect(centerOf({ x: 100, y: 50, width: 40, height: 24 })).toEqual({ x: 120, y: 62 });
    expect(centerOf({ x: -1920, y: 0, width: 5760, height: 1080 })).toEqual({ x: 960, y: 540 });
  });
});

/**
 * Wiring tests: the TS->PowerShell bridge (runPowerShell / parsePsJson /
 * failFromPs / readUiTree) against a stubbed `powershell` executable.
 * Posix-only (on Windows a real powershell.exe must not be faked).
 */
describe("PowerShell bridge wiring (stubbed powershell, posix CI only)", () => {
  const isPosix = process.platform === "darwin" || process.platform === "linux";
  let stubPath = "";

  if (isPosix) {
    const dir = mkdtempSync(join(tmpdir(), "uia-stub-"));
    stubPath = join(dir, "powershell-stub");
    writeFileSync(
      stubPath,
      [
        "#!/bin/sh",
        'if [ "${WIN_STUB_EXIT:-0}" != "0" ]; then printf "%s\\n" "$WIN_STUB_STDERR" >&2; fi',
        'printf "%s\\n" "$WIN_STUB_STDOUT"',
        "exit ${WIN_STUB_EXIT:-0}",
        "",
      ].join("\n"),
    );
    chmodSync(stubPath, 0o755);
  }

  afterEach(() => {
    delete process.env.UIVENUS_POWERSHELL;
    delete process.env.WIN_STUB_STDOUT;
    delete process.env.WIN_STUB_STDERR;
    delete process.env.WIN_STUB_EXIT;
  });

  /**
   * Feed the adapter the REAL stdout captured from uia-tree.ps1 on the
   * Windows 11 test host (session-0 SSH context: the empty desktop pane
   * is the only element visible). Verified verbatim on DESKTOP-N8HLVGG.
   */
  const realBoxOutput =
    '[{"runtimeId":"42,15728760","role":"ControlType.Pane","name":"","value":"","enabled":true,' +
    '"bounds":{"y":0,"width":1024,"height":768,"x":0},"patterns":[],"depth":0,"pid":976,' +
    '"className":"#32769","autoId":""}]';

  it.runIf(isPosix)("readUiTree runs the PS bridge and parses real captured output", async () => {
    process.env.UIVENUS_POWERSHELL = stubPath;
    process.env.WIN_STUB_STDOUT = realBoxOutput;
    const els = await readUiTree({ desktopRoot: true });
    expect(els).toHaveLength(1);
    expect(els[0]!.runtimeId).toBe("42,15728760");
    expect(els[0]!.role).toBe("ControlType.Pane");
    expect(els[0]!.bounds).toEqual({ x: 0, y: 0, width: 1024, height: 768 });
    expect(normalizeRole(els[0]!.role)).toBe("pane");
  });

  it.runIf(isPosix)("maps PS failure markers to honest ComputerUseError codes", () => {
    process.env.UIVENUS_POWERSHELL = stubPath;
    process.env.WIN_STUB_EXIT = "3";
    process.env.WIN_STUB_STDERR = "PROCESS_NOT_FOUND: no top-level windows for pid(s) 2028";
    process.env.WIN_STUB_STDOUT = "[]";
    let caught: unknown;
    try {
      const r = { code: 3, stdout: "[]", stderr: "PROCESS_NOT_FOUND: no top-level windows for pid(s) 2028" };
      throw failFromPs("uia-tree.ps1", r);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ComputerUseError);
    expect((caught as ComputerUseError).code).toBe("element_not_found");

    expect(failFromPs("input.ps1", { code: 6, stdout: "", stderr: "INPUT_FAILED: injected 0 of 1 events" }).code).toBe("restricted");
    expect(failFromPs("uia-action.ps1", { code: 4, stdout: "", stderr: "PATTERN_NOT_SUPPORTED: Invoke" }).code).toBe("unsupported");
    expect(failFromPs("input.ps1", { code: 7, stdout: "", stderr: "UNKNOWN_KEY: f25" }).code).toBe("invalid_request");
    expect(failFromPs("screen.ps1", { code: 8, stdout: "", stderr: "CAPTURE_FAILED: The handle is invalid" }).code).toBe("internal_error");
    expect(failFromPs("uia-action.ps1", { code: 6, stdout: "", stderr: "VERIFY_FAILED: value mismatch" }).code).toBe("stalled");

    // parsePsJson surfaces the same mapping for non-zero exit + unparseable stdout
    expect(() => parsePsJson("x.ps1", { code: 1, stdout: "garbage{", stderr: "" })).toThrow(ComputerUseError);
  });
});
