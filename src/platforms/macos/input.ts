/**
 * CGEvent-based input for macOS (JXA). Mouse and keyboard posting requires
 * Accessibility permission; failures surface as permission_required.
 *
 * macOS logical-point space matches System Events `position` space, so
 * no conversion is needed between element bounds and click coordinates.
 */
import { ComputerUseError } from "../../core/errors.js";
import { jxa } from "../exec.js";

async function postJxa(script: string): Promise<void> {
  try {
    await jxa(script, 15_000);
  } catch (e) {
    const msg = (e as Error).message;
    if (/not allowed assistive|accessibility|1002|-25211|-1719/i.test(msg)) {
      throw new ComputerUseError("permission_required", "macOS refused to post the input event", {
        hint: "Grant Accessibility permission to the terminal/host app: System Settings → Privacy & Security → Accessibility.",
        cause: e,
      });
    }
    throw e;
  }
}

export async function mouseMove(x: number, y: number): Promise<void> {
  await postJxa(`
    ObjC.import("CoreGraphics");
    const p = $.CGPointMake(${x}, ${y});
    const e = $.CGEventCreateMouseEvent($(), $.kCGEventMouseMoved, p, 0);
    $.CGEventPost($.kCGHIDEventTap, e);
  `);
}

function mouseEventScript(type: string, x: number, y: number, clickState: number, button: number): string {
  return `
    const p = $.CGPointMake(${x}, ${y});
    const e = $.CGEventCreateMouseEvent($(), $.${type}, p, ${button});
    $.CGEventSetIntegerValueField(e, $.kCGMouseEventClickState, ${clickState});
    $.CGEventPost($.kCGHIDEventTap, e);
  `;
}

export async function mouseClick(x: number, y: number, button: "left" | "right" = "left", clicks = 1): Promise<void> {
  const parts: string[] = ['ObjC.import("CoreGraphics");'];
  if (button === "left") {
    // Emit the full click-state chain so apps recognize double clicks.
    for (let state = 1; state <= clicks; state++) {
      parts.push(mouseEventScript("kCGEventLeftMouseDown", x, y, state, 0));
      parts.push(mouseEventScript("kCGEventLeftMouseUp", x, y, state, 0));
    }
  } else {
    parts.push(mouseEventScript("kCGEventRightMouseDown", x, y, clicks, 1));
    parts.push(mouseEventScript("kCGEventRightMouseUp", x, y, clicks, 1));
  }
  await postJxa(parts.join("\n"));
}

export async function mouseDrag(
  from: { x: number; y: number },
  to: { x: number; y: number },
  durationMs = 400,
  button: "left" | "right" = "left",
): Promise<void> {
  const steps = Math.max(8, Math.min(40, Math.round(durationMs / 15)));
  const types =
    button === "left"
      ? ["kCGEventLeftMouseDown", "kCGEventLeftMouseDragged", "kCGEventLeftMouseUp"]
      : ["kCGEventRightMouseDown", "kCGEventRightMouseDragged", "kCGEventRightMouseUp"];
  const b = button === "left" ? 0 : 1;
  const lines: string[] = ['ObjC.import("CoreGraphics");'];
  lines.push(mouseEventScript(types[0]!, from.x, from.y, 1, b));
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    lines.push(mouseEventScript(types[1]!, x, y, 1, b));
  }
  lines.push(mouseEventScript(types[2]!, to.x, to.y, 1, b));
  await postJxa(lines.join("\n"));
}

export async function scroll(x: number, y: number, direction: "up" | "down" | "left" | "right", amount: number): Promise<void> {
  // amount is in "wheel clicks"; ~40 px per click via pixel units.
  const px = Math.round(Math.max(1, amount) * 40);
  const vertical = direction === "up" ? px : direction === "down" ? -px : 0;
  const horizontal = direction === "right" ? px : direction === "left" ? -px : 0;
  await postJxa(`
    ObjC.import("CoreGraphics");
    const p = $.CGPointMake(${x}, ${y});
    const move = $.CGEventCreateMouseEvent($(), $.kCGEventMouseMoved, p, 0);
    $.CGEventPost($.kCGHIDEventTap, move);
    const e = $.CGEventCreateScrollWheelEvent2($(), $.kCGScrollEventUnitPixel, 1, ${vertical}, ${horizontal}, 0);
    $.CGEventPost($.kCGHIDEventTap, e);
  `);
}

/** Virtual key codes (kVK_ANSI_*). */
export const KEY_CODES: Record<string, number> = {
  enter: 36, return: 36, tab: 48, escape: 53, esc: 53, space: 49, delete: 51, backspace: 51,
  forwarddelete: 117, home: 115, end: 119, pageup: 116, pagedown: 121,
  left: 123, right: 124, down: 125, up: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109,
  f11: 103, f12: 111,
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14,
  r: 15, y: 16, t: 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24,
  "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, o: 31, u: 32, "[": 33, i: 34,
  p: 35, l: 37, j: 38, "'": 39, k: 40, ";": 41, "\\": 42, ",": 43, "/": 44, n: 45, m: 46,
  ".": 47, "`": 50,
};

export const MODIFIER_FLAGS: Record<string, number> = {
  shift: 0x02, control: 0x04, ctrl: 0x04, option: 0x08, alt: 0x08, command: 0x10, cmd: 0x10,
  meta: 0x10, fn: 0x800000,
};

export async function pressKey(key: string, modifiers: string[] = []): Promise<void> {
  const k = key.toLowerCase();
  const code = KEY_CODES[k];
  let flags = 0;
  for (const m of modifiers) flags |= MODIFIER_FLAGS[m.toLowerCase()] ?? 0;
  if (code === undefined) {
    if ([...k].length === 1 && flags === 0) {
      await typeText(k);
      return;
    }
    throw new ComputerUseError("invalid_request", `Unknown key: ${key}`, {
      hint: "Use macOS virtual-key names (enter, tab, escape, arrows, f1-f12, letters, digits) or type() for text.",
    });
  }
  await postJxa(`
    ObjC.import("CoreGraphics");
    const down = $.CGEventCreateKeyboardEvent($(), ${code}, true);
    const up = $.CGEventCreateKeyboardEvent($(), ${code}, false);
    $.CGEventSetFlags(down, ${flags});
    $.CGEventSetFlags(up, ${flags});
    $.CGEventPost($.kCGHIDEventTap, down);
    delay(0.01);
    $.CGEventPost($.kCGHIDEventTap, up);
  `);
}

/**
 * Unicode-safe typing: CGEventKeyboardSetUnicodeString bridges JS strings
 * directly in JXA, so ASCII and CJK both work without clipboard side effects.
 */
export async function typeText(text: string): Promise<void> {
  const json = JSON.stringify(text);
  await postJxa(`
    ObjC.import("CoreGraphics");
    const text = ${json};
    const down = $.CGEventCreateKeyboardEvent($(), 0, true);
    const up = $.CGEventCreateKeyboardEvent($(), 0, false);
    $.CGEventKeyboardSetUnicodeString(down, text.length, text);
    $.CGEventKeyboardSetUnicodeString(up, text.length, text);
    $.CGEventPost($.kCGHIDEventTap, down);
    delay(0.02);
    $.CGEventPost($.kCGHIDEventTap, up);
  `);
}

/**
 * Clipboard-based typing fallback (long text / apps that ignore synthetic
 * unicode key events): pbcopy + Cmd+V. NOTE: overwrites the user clipboard.
 */
export async function typeTextViaClipboard(text: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const p = execFile("pbcopy", [], (err) => (err ? reject(err) : resolve()));
    p.stdin!.end(text, "utf8");
  });
  await pressKey("v", ["command"]);
}
