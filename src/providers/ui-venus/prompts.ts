/**
 * Prompt construction & response parsing for UI-Venus (UI-TARS compatible).
 *
 * Grounding prompt is the official UI-Venus usage (verified against the
 * W8A8 endpoint); agent stepping follows UI-TARS-style action syntax with
 * a tolerant parser that also accepts JSON.
 */

/** Official grounding prompt (§ documented usage). */
export function groundingPrompt(instruction: string): string {
  return (
    "Output the center point of the position corresponding to the following instruction: \n" +
    `${instruction}. \n\n` +
    "The output should just be the coordinates of a point, in the format [x,y]. " +
    "Additionally, if the task is infeasible (e.g., the task is not related to the image), " +
    "the output should be [-1,-1]."
  );
}

/** Verification prompt: strict yes/no + evidence. */
export function verifyPrompt(goal: string): string {
  return (
    `Look at this screenshot. The goal was: "${goal}".\n\n` +
    "Does the current screen state satisfy the goal? " +
    'Answer with exactly one JSON object: {"pass": true|false, "evidence": "<one short sentence describing what you see>"}'
  );
}

/** Inspection prompt. */
export function inspectPrompt(focus?: string): string {
  const base =
    "Describe the user interface shown in this screenshot. List the visible interactive elements " +
    "with their type and label, and summarize what application/screen this is.";
  return focus ? `${base}\nFocus on: ${focus}` : base;
}

/**
 * Agent stepping prompt (UI-TARS-1.5-compatible action space, adapted to
 * this MCP's unified actions). The model must answer with exactly one
 * action in the documented syntax.
 */
export function agentSystemPrompt(): string {
  return [
    "You are a GUI automation expert controlling a real user interface. You will receive:",
    "- The user's goal (instruction)",
    "- A screenshot of the current screen",
    "- The history of previously executed actions",
    "",
    "Analyze the screenshot and output EXACTLY ONE next action to progress toward the goal.",
    "",
    "Available action syntax (output exactly one line starting with 'Action:'):",
    "Thought: <one short sentence reasoning about the screen>",
    "Action: click(x, y)                # x,y are [0,1000] normalized coordinates of the element center",
    "Action: left_double(x, y)",
    "Action: right_single(x, y)",
    "Action: long_press(x, y)",
    "Action: drag(x1, y1, x2, y2)",
    "Action: type(content)              # type this text into the currently focused input",
    "Action: hotkey(key)                # e.g. hotkey(ctrl+c), hotkey(command+space), hotkey(enter)",
    "Action: scroll(x, y, direction, magnitude)  # direction in up/down/left/right, magnitude 1-10",
    "Action: wait()",
    "Action: finished()                 # ONLY when the goal is fully achieved on the current screen",
    "Action: fail(reason)               # when the goal is impossible",
    "",
    "Rules:",
    "- Coordinates are normalized to [0,1000] relative to the screenshot.",
    "- If the goal has been achieved (evidence visible on screen), output finished().",
    "- Never repeat an action that already failed according to history.",
    "- Output only one Thought line and one Action line.",
  ].join("\n");
}

export function agentUserPrompt(goal: string, history: { index: number; summary: string; ok: boolean; error?: string }[], language?: string): string {
  const lang = language === "zh" ? "请用中文写 Thought。" : "";
  const hist = history.length
    ? history
        .map(
          (h) =>
            `${h.index}. ${h.summary} → ${h.ok ? "ok" : `FAILED${h.error ? ` (${h.error})` : ""}`}`,
        )
        .join("\n")
    : "(no previous actions)";
  return `Instruction: ${goal}\n\nPrevious actions:\n${hist}\n\nNow output the next single action.\n${lang}`;
}

/** ------------------------------------------------------------------ parsing */

export interface ParsedPoint {
  x: number;
  y: number;
  feasible: boolean;
}

/**
 * Parse "[x, y]" out of grounding output. Tolerates surrounding text,
 * full-width brackets/commas, and float values. Returns feasible=false
 * for [-1,-1].
 */
export function parseGroundingPoint(text: string): ParsedPoint | null {
  const cleaned = text.replace(/[（【]/g, "[").replace(/[）】]/g, "]").replace(/，/g, ",");
  const matches = [...cleaned.matchAll(/\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/g)];
  const last = matches[matches.length - 1];
  if (!last) return null;
  const x = Number.parseFloat(last[1]!);
  const y = Number.parseFloat(last[2]!);
  const feasible = !(x === -1 && y === -1);
  return { x, y, feasible };
}

export interface ParsedDecision {
  thought?: string;
  actionLine: string;
}

/** Split "Thought: ..." / "Action: ..." blocks. */
export function parseAgentResponse(text: string): ParsedDecision | null {
  const thoughtMatch = text.match(/Thought\s*[:：]\s*(.+)/i);
  const actionMatch = text.match(/Action\s*[:：]\s*(.+)/i);
  if (!actionMatch) {
    // Some models answer with a bare function call — accept that.
    const bare = text.match(/\b(click|left_double|right_single|long_press|drag|type|hotkey|scroll|wait|finished|fail)\s*\(/i);
    if (!bare) return null;
    return { thought: thoughtMatch?.[1], actionLine: text.slice(bare.index ?? 0).trim() };
  }
  return { thought: thoughtMatch?.[1], actionLine: actionMatch[1]!.trim() };
}

export type VenusActionCall =
  | { kind: "click"; x: number; y: number }
  | { kind: "double_click"; x: number; y: number }
  | { kind: "right_click"; x: number; y: number }
  | { kind: "long_press"; x: number; y: number }
  | { kind: "drag"; from: { x: number; y: number }; to: { x: number; y: number } }
  | { kind: "type"; text: string }
  | { kind: "hotkey"; keys: string[] }
  | { kind: "scroll"; x: number; y: number; direction: "up" | "down" | "left" | "right"; magnitude: number }
  | { kind: "wait" }
  | { kind: "finished" }
  | { kind: "fail"; reason: string };

/**
 * Parse the action call out of a line. The kind token is searched anywhere
 * in the line (survives code fences, "Action:" prefixes and trailing
 * prose); arguments run to the LAST closing paren.
 */
export function parseActionLine(line: string): VenusActionCall | null {
  const cleaned = line.replace(/```/g, "").trim();
  const m = cleaned.match(
    /\b(click|left_double|right_single|long_press|drag|type|hotkey|scroll|wait|finished|fail)\s*\(/i,
  );
  if (!m) return null;
  const kind = m[1]!.toLowerCase();
  const start = m.index! + m[0].length;
  const end = cleaned.lastIndexOf(")");
  if (end <= start) {
    // wait()/finished() legitimately have empty args
    if (kind === "wait") return { kind: "wait" };
    if (kind === "finished") return { kind: "finished" };
    return null;
  }
  const args = splitArgs(cleaned.slice(start, end));

  switch (kind) {
    case "click":
    case "left_double":
    case "right_single":
    case "long_press": {
      const x = num(args[0]);
      const y = num(args[1]);
      if (x === null || y === null) return null;
      const k =
        kind === "click" ? "click" : kind === "left_double" ? "double_click" : kind === "right_single" ? "right_click" : "long_press";
      return { kind: k as "click" | "double_click" | "right_click" | "long_press", x, y } as VenusActionCall;
    }
    case "drag": {
      const x1 = num(args[0]);
      const y1 = num(args[1]);
      const x2 = num(args[2]);
      const y2 = num(args[3]);
      if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
      return { kind: "drag", from: { x: x1, y: y1 }, to: { x: x2, y: y2 } };
    }
    case "type": {
      const text = unquote(stripArgName(args.join(",")));
      if (!text) return null;
      return { kind: "type", text };
    }
    case "hotkey": {
      const raw = unquote(stripArgName(args.join(","))).toLowerCase();
      if (!raw) return null;
      const keys = raw.split(/[+＋]/).map((k) => k.trim()).filter(Boolean);
      return { kind: "hotkey", keys };
    }
    case "scroll": {
      const x = num(args[0]);
      const y = num(args[1]);
      const dirRaw = stripArgName(args[2] ?? "down").toLowerCase().replace(/['"]/g, "");
      const mag = num(args[3]) ?? 3;
      const direction = ["up", "down", "left", "right"].includes(dirRaw)
        ? (dirRaw as "up" | "down" | "left" | "right")
        : "down";
      if (x === null || y === null) {
        return { kind: "scroll", x: 500, y: 500, direction, magnitude: mag };
      }
      return { kind: "scroll", x, y, direction, magnitude: mag };
    }
    case "wait":
      return { kind: "wait" };
    case "finished":
      return { kind: "finished" };
    case "fail":
      return { kind: "fail", reason: unquote(stripArgName(args.join(","))) || "model declared failure" };
    default:
      return null;
  }
}

/** Strip a leading "name=" parameter label ("x=676", "content='hi'"). */
function stripArgName(v: string): string {
  return v.replace(/^\w+\s*=\s*/, "");
}

function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (const ch of s) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Parse an arg as a number; tolerates named args like "x=676" or "y = 683". */
function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const stripped = v.replace(/^\w+\s*=\s*/, "").replace(/['" ]/g, "");
  const n = Number.parseFloat(stripped);
  return Number.isFinite(n) ? n : null;
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Parse the JSON verify answer. */
export function parseVerifyAnswer(text: string): { pass: boolean; evidence: string } | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]) as { pass?: boolean; evidence?: string };
      if (typeof obj.pass === "boolean") {
        return { pass: obj.pass, evidence: obj.evidence ?? "" };
      }
    } catch {
      /* fall through */
    }
  }
  const yes = /\b(yes|true|是|通过)\b/i.test(text);
  const no = /\b(no|false|否|不通过|未)\b/i.test(text);
  if (yes !== no) return { pass: yes, evidence: text.trim().slice(0, 300) };
  return null;
}
