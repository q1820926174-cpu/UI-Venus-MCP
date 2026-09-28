/**
 * UI-Venus official protocol implementation (verified against
 * inclusionAI/UI-Venus @ UI-Venus-2 branch, models/computer/computer_example.py
 * and the ModelScope model card, 2026-09-28).
 *
 * Two task families, two protocols:
 *  - GUI grounding: single-shot, non-thinking, temperature 0, [0,1000]
 *    normalized "[x, y]" output (matches models/grounding).
 *  - Agentic loop (Computer): official SYSTEM_PROMPT, <think>/<action>
 *    output, Python-call action grammar (Click(box=(x, y)), Drag(end=…),
 *    Swipe(amount=, axis=), Sequence(actions=[…]), Finished, CallUser…),
 *    coordinates normalized to [0,999] and converted with
 *    `int(v * size / 999)` clamped to [0, size-1]; multi-turn context keeps
 *    ALL accepted assistant turns plus the last N history screenshots.
 *    Model card: agentic tasks use temperature 1.0 + reasoning retained;
 *    the shipped example defaults to temperature 0 + thinking off — both
 *    are configurable (VENUS_AGENT_TEMPERATURE / VENUS_AGENT_ENABLE_THINKING).
 */

/** Official grounding prompt (models/grounding contract). */
export function groundingPrompt(instruction: string): string {
  return (
    "Output the center point of the position corresponding to the following instruction: \n" +
    `${instruction}. \n\n` +
    "The output should just be the coordinates of a point, in the format [x,y]. " +
    "Additionally, if the task is infeasible (e.g., the task is not related to the image), " +
    "the output should be [-1,-1]."
  );
}

/** Verification prompt: final-state judgment + strict JSON contract. */
export function verifyPrompt(goal: string): string {
  return (
    `Look at this screenshot. The goal was: "${goal}".\n\n` +
    "Judge ONLY by the final visible state (results, outputs, checked items, shown values) — " +
    "do NOT require the action history or intermediate steps to be visible. " +
    "Does the current screen show that the goal has been achieved? " +
    'Answer with exactly one JSON object: {"pass": true|false, "evidence": "<one short sentence describing what you see>"}'
  );
}

/** Inspection prompt (MCP-specific). */
export function inspectPrompt(focus?: string): string {
  const base =
    "Describe the user interface shown in this screenshot. List the visible interactive elements " +
    "with their type and label, and summarize what application/screen this is.";
  return focus ? `${base}\nFocus on: ${focus}` : base;
}

/**
 * OFFICIAL Computer system prompt (verbatim from models/computer/
 * computer_example.py SYSTEM_PROMPT, with {sudo_password} parameterized —
 * defaults to "(not provided)"; set VENUS_SUDO_PASSWORD to override).
 * {user_task} is substituted with the goal.
 */
export const COMPUTER_SYSTEM_PROMPT = `**You are a GUI Agent.**
Your role is to analyze the user's task, provide clear and accurate answers to their questions, and execute the task with precise actions on a desktop operating system. The password of the computer is {sudo_password}.

### Available Actions
You may execute one of the following functions. Coordinates range from the top-left corner (0, 0) to the bottom-right corner (999, 999).
- Click(box=(x1, y1)), or Click()
> Perform a left-click at \`box\`, or at the current cursor position when \`box\` is omitted.
- DoubleClick(box=(x1, y1)), or DoubleClick()
> Perform a double-click (selects a word in text). Use \`box\` to move first, or omit it to act at the current cursor position.
- TripleClick(box=(x1, y1)), or TripleClick()
> Perform a triple-click (selects a line or the content of a single-line input). Use \`box\` to move first, or omit it to act at the current cursor position.
- RightClick(box=(x1, y1)), or RightClick()
> Perform a right-click to open a context menu. Use \`box\` to move first, or omit it to act at the current cursor position.
- MiddleClick(box=(x1, y1)), or MiddleClick()
> Perform a middle-click (for example, open a link in a new tab). Use \`box\` to move first, or omit it to act at the current cursor position.
- Hover(box=(x1, y1))
> Move the cursor immediately to the coordinate WITHOUT clicking.
- Drag(end=(x2, y2), start=(x1, y1))
> Drag to \`end\` using a fixed 0.5-second drag. \`start\` is optional; omit it to begin from the current cursor position.
- Swipe(amount=-5, axis='vertical')
> Scroll at the current cursor position. \`amount\` is an integer from -4096 to 4096 and controls magnitude and direction: vertical positive scrolls up and negative scrolls down; horizontal positive scrolls right and negative scrolls left.
- Type(content='')
> Type the provided text into the focused field. Each \`\n\` presses Enter.
- Hotkey(keys=['ctrl', 'c'], repeat=1)
> Press 1 to 128 listed keys as a keyboard shortcut. Use \`repeat=N\` from 1 to 128 to press the shortcut N times.
- KeyDown(keys=['shift'])
> Press 1 to 128 listed keys in order and keep them held across later actions and model turns until a matching \`KeyUp\`.
- KeyUp(keys=['shift'])
> Release 1 to 128 listed keys in order.
- MouseDown(box=(x1, y1)), or MouseDown()
> Optionally move to \`box\`, then press and hold the left mouse button across later actions and model turns.
- MouseUp(box=(x1, y1)), or MouseUp()
> Optionally move to \`box\`, then release the left mouse button.
- Sequence(actions=[Click(box=(x1, y1)), Hotkey(keys=['ctrl', 's'])])
> Execute 2 to 32 actions in order as one open-loop model turn. Nested \`Sequence\` is not allowed, and \`CallUser\` or \`Finished\` may appear only as the final action.
- Wait()
> Wait for the current page, animation, or content to finish loading.
- CallUser(content='')
> Request user takeover or report failure when the task cannot be completed or additional information is required.
- Finished(content='')
> Mark the task as completed successfully and optionally report details in \`content\`.

### Instructions
- Make sure you understand the task goal to avoid wrong actions.
- Prefer one atomic action per turn. Use \`Sequence\` only when every child action is already known and no intermediate screenshot is needed; its children execute open-loop.
- \`KeyDown\`, \`KeyUp\`, \`MouseDown\`, and \`MouseUp\` preserve input state across turns. Release held input explicitly when it is no longer needed.
- Any \`keys\` list may contain at most 128 non-empty key names; each key name is limited to 1,024 characters.
- \`Swipe\` is the only scrolling action and always scrolls at the current cursor position.
- Make sure you carefully examine the current screenshot. Sometimes the summarized history might not be reliable, over-claiming some effects.
- To submit/search after typing into a field, end the text with a newline — \`Type(content='query\\n')\` — which types the text and presses Enter in one action.
- To replace the existing content of an input field, use \`TripleClick\` to select it, then \`Type\` the new content.
- To open a submenu/dropdown, use \`Hover\` over the parent item to reveal it, then \`Click\` the desired entry.
- To use a context menu, \`RightClick\` the target to open it, then \`Click\` the desired entry.
- To hold a modifier during another action, use \`KeyDown\`, the target action, and \`KeyUp\`. Put them in one \`Sequence\` only when no intermediate screenshot is needed.
- After launching an app, running a command, downloading, or any slow operation, use \`Wait()\` to let it finish before continuing.
- To press a key or shortcut several times, use \`repeat\`, e.g. \`Hotkey(keys=['down'], repeat=5)\` or \`Hotkey(keys=['ctrl', 'z'], repeat=3)\`, instead of repeating the action.
- Consider exploring the screen by using the \`Swipe\` action to scroll and reveal additional content.
- Use \`Hotkey\` for keyboard shortcuts: copy (\`ctrl+c\`), paste (\`ctrl+v\`), save (\`ctrl+s\`), undo (\`ctrl+z\`), find (\`ctrl+f\`), etc.
- If the task cannot be completed or additional information is needed, use \`CallUser\`. Use \`Finished\` only after successful completion.

### Output Format
<think> your thinking process </think>
<action> the next action </action>

### User Task
{user_task}`;

export function computerSystemPrompt(userTask: string, sudoPassword = "(not provided)"): string {
  return COMPUTER_SYSTEM_PROMPT.replace("{sudo_password}", sudoPassword).replace("{user_task}", userTask);
}

/** ------------------------------------------------------------------ parsing */

export interface ParsedPoint {
  x: number;
  y: number;
  feasible: boolean;
}

/** Parse "[x, y]" grounding output ([0,1000] space); [-1,-1] → infeasible. */
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

/**
 * Official response parsing (parse_response equivalent): exactly one
 * <action> block (or the bare text as action), optional <think> block.
 * `reasoningContent` (vLLM reasoning_content when thinking is enabled) is
 * treated as the thought when no <think> tag is present.
 */
export function parseOfficialResponse(
  text: string,
  reasoningContent = "",
): { thought: string; actionText: string } {
  const actionBlocks = [...text.matchAll(/<action>\s*([\s\S]*?)\s*<\/action>/gi)];
  let actionText: string;
  if (actionBlocks.length > 0) {
    if (actionBlocks.length !== 1) {
      throw new Error("expected exactly one <action> block");
    }
    actionText = actionBlocks[0]![1]!.trim();
  } else if (/<action/i.test(text) || /<\/action>/i.test(text)) {
    throw new Error("malformed <action> block");
  } else {
    actionText = text.trim();
  }
  if (!actionText) throw new Error("empty action");
  const thinkMatch = text.match(/<think>\s*([\s\S]*?)\s*<\/think>/i);
  const thought = reasoningContent.trim() || (thinkMatch ? thinkMatch[1]!.trim() : "");
  return { thought, actionText };
}

/** ------------------------------------------------------- official action grammar */

export type ComputerArgValue = string | number | boolean | null | ComputerArgValue[] | [number, number];

export interface ComputerActionCall {
  name: string;
  args: Record<string, ComputerArgValue>;
  children?: ComputerActionCall[];
}

const SCHEMAS: Record<string, { required: string[]; optional: string[] }> = {
  Click: { required: [], optional: ["box"] },
  DoubleClick: { required: [], optional: ["box"] },
  TripleClick: { required: [], optional: ["box"] },
  RightClick: { required: [], optional: ["box"] },
  MiddleClick: { required: [], optional: ["box"] },
  Hover: { required: ["box"], optional: [] },
  Drag: { required: ["end"], optional: ["start"] },
  Swipe: { required: ["amount", "axis"], optional: [] },
  Type: { required: [], optional: ["content"] },
  Hotkey: { required: ["keys"], optional: ["repeat"] },
  KeyDown: { required: ["keys"], optional: [] },
  KeyUp: { required: ["keys"], optional: [] },
  MouseDown: { required: [], optional: ["box"] },
  MouseUp: { required: [], optional: ["box"] },
  Wait: { required: [], optional: [] },
  CallUser: { required: [], optional: ["content"] },
  Finished: { required: [], optional: ["content"] },
};

const TERMINALS = new Set(["CallUser", "Finished"]);
const COORD_ARGS = new Set(["box", "start", "end"]);

/**
 * Parser for the official action grammar — the safe subset of Python call
 * syntax: Name(kw=v, …) with string/number/bool/None/list/tuple literals.
 * Positional args, **kwargs, and nested Sequence are rejected (mirrors the
 * official AST-based parser's guarantees without eval'ing anything).
 */
export function parseActionCall(text: string, allowSequence = true): ComputerActionCall {
  const src = text.trim();
  if (!src) throw new Error("action text must be a non-empty string");
  const p = new CallParser(src);
  const call = p.parseCall(allowSequence);
  p.skipWs();
  if (p.pos < p.src.length) throw new Error(`unexpected trailing content at ${p.pos}`);
  validateCall(call, allowSequence);
  return call;
}

class CallParser {
  pos = 0;
  constructor(readonly src: string) {}
  skipWs(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) this.pos++;
  }
  peek(): string {
    return this.src[this.pos] ?? "";
  }
  expect(ch: string): void {
    this.skipWs();
    if (this.peek() !== ch) throw new Error(`expected '${ch}' at ${this.pos}`);
    this.pos++;
  }
  parseIdentifier(): string {
    this.skipWs();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    if (!m) throw new Error(`expected identifier at ${this.pos}`);
    this.pos += m[0].length;
    return m[0];
  }
  parseLiteral(): ComputerArgValue {
    this.skipWs();
    const c = this.peek();
    if (c === "'" || c === '"') return this.parseString();
    if (c === "-" || c === "+" || /[0-9]/.test(c)) return this.parseNumber();
    if (c === "[") {
      this.pos++;
      const out: ComputerArgValue[] = [];
      this.skipWs();
      if (this.peek() === "]") {
        this.pos++;
        return out;
      }
      for (;;) {
        out.push(this.parseLiteral());
        this.skipWs();
        if (this.peek() === ",") {
          this.pos++;
          continue;
        }
        break;
      }
      this.expect("]");
      return out;
    }
    if (c === "(") {
      // tuple → treat as list; coordinate tuples validated at the schema layer
      this.pos++;
      const out: ComputerArgValue[] = [];
      this.skipWs();
      if (this.peek() === ")") {
        this.pos++;
        return out;
      }
      for (;;) {
        out.push(this.parseLiteral());
        this.skipWs();
        if (this.peek() === ",") {
          this.pos++;
          this.skipWs();
          if (this.peek() === ")") {
            this.pos++;
            break;
          }
          continue;
        }
        break;
      }
      this.expect(")");
      return out;
    }
    const word = this.parseIdentifier();
    if (word === "True") return true;
    if (word === "False") return false;
    if (word === "None") return null;
    throw new Error(`unsupported literal '${word}' (only strings, numbers, bools, None, lists, tuples)`);
  }
  parseString(): string {
    const quote = this.peek();
    this.pos++;
    let out = "";
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos]!;
      if (ch === "\\") {
        const next = this.src[this.pos + 1];
        if (next === "n") out += "\n";
        else if (next === "t") out += "\t";
        else if (next === "\\") out += "\\";
        else if (next === quote) out += quote;
        else out += next ?? "";
        this.pos += 2;
        continue;
      }
      if (ch === quote) {
        this.pos++;
        return out;
      }
      out += ch;
      this.pos++;
    }
    throw new Error("unterminated string literal");
  }
  parseNumber(): number {
    this.skipWs();
    const m = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(this.src.slice(this.pos));
    if (!m) throw new Error(`invalid number at ${this.pos}`);
    this.pos += m[0].length;
    const n = Number.parseFloat(m[0]);
    if (!Number.isFinite(n)) throw new Error("non-finite number");
    return n;
  }
  parseCall(allowSequence: boolean): ComputerActionCall {
    const name = this.parseIdentifier();
    this.expect("(");
    const args: Record<string, ComputerArgValue> = {};
    let children: ComputerActionCall[] | undefined;
    this.skipWs();
    if (this.peek() === ")") {
      this.pos++;
    } else {
      for (;;) {
        const key = this.parseIdentifier();
        this.expect("=");
        if (name === "Sequence" && key === "actions") {
          if (!allowSequence) throw new Error("nested Sequence is not allowed");
          children = this.parseActionList();
        } else {
          if (key in args) throw new Error(`duplicate argument: ${key}`);
          args[key] = this.parseLiteral();
        }
        this.skipWs();
        if (this.peek() === ",") {
          this.pos++;
          continue;
        }
        break;
      }
      this.expect(")");
    }
    const call: ComputerActionCall = { name, args };
    if (children) call.children = children;
    return call;
  }
  parseActionList(): ComputerActionCall[] {
    this.expect("[");
    const out: ComputerActionCall[] = [];
    this.skipWs();
    if (this.peek() === "]") {
      this.pos++;
      return out;
    }
    for (;;) {
      out.push(this.parseCall(false));
      this.skipWs();
      if (this.peek() === ",") {
        this.pos++;
        this.skipWs();
        if (this.peek() === "]") {
          this.pos++;
          break;
        }
        continue;
      }
      break;
    }
    this.expect("]");
    return out;
  }
}

function isCoordinateTuple(v: ComputerArgValue): v is [number, number] {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    v.every((x) => typeof x === "number" && Number.isFinite(x)) &&
    v.every((x) => (x as number) >= 0 && (x as number) <= 999)
  );
}

export function validateCall(call: ComputerActionCall, allowSequence = true): void {
  if (call.name === "Sequence") {
    if (!allowSequence) throw new Error("nested Sequence is not allowed");
    const n = call.children?.length ?? 0;
    if (call.children === undefined || n < 2 || n > 32) {
      throw new Error("Sequence requires actions=[...] with 2-32 actions");
    }
    call.children.forEach((child, i) => {
      validateCall(child, false);
      if (TERMINALS.has(child.name) && i !== n - 1) {
        throw new Error("terminal action must be last in Sequence");
      }
    });
    return;
  }
  const schema = SCHEMAS[call.name];
  if (!schema) throw new Error(`unsupported Computer action: '${call.name}'`);
  const actual = Object.keys(call.args);
  const missing = schema.required.filter((k) => !actual.includes(k));
  const unknown = actual.filter((k) => !schema.required.includes(k) && !schema.optional.includes(k));
  if (missing.length) throw new Error(`${call.name} missing arguments: ${missing.join(",")}`);
  if (unknown.length) throw new Error(`${call.name} has unknown arguments: ${unknown.join(",")}`);
  for (const [key, value] of Object.entries(call.args)) {
    if (COORD_ARGS.has(key)) {
      if (!isCoordinateTuple(value)) {
        throw new Error(`${call.name}.${key} must be a two-number tuple in [0, 999]`);
      }
    } else if (key === "keys") {
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.some((v) => typeof v !== "string" || !v.trim())
      ) {
        throw new Error(`${call.name}.keys must be a non-empty string list`);
      }
    } else if (key === "repeat") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        throw new Error("Hotkey.repeat must be a positive integer");
      }
    } else if (key === "amount") {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new Error("Swipe.amount must be an integer");
      }
    } else if (key === "axis") {
      if (value !== "vertical" && value !== "horizontal") {
        throw new Error("Swipe.axis must be 'vertical' or 'horizontal'");
      }
    } else if (key === "content") {
      if (typeof value !== "string") throw new Error(`${call.name}.content must be a string`);
    }
  }
}

/** Official coordinate conversion: int(v * size / 999), clamped to [0, size-1]. */
export function normalizedPoint999(v: [number, number], width: number, height: number): { x: number; y: number } {
  if (width <= 0 || height <= 0) throw new Error("image dimensions must be positive");
  return {
    x: Math.max(0, Math.min(width - 1, Math.trunc((v[0] * width) / 999))),
    y: Math.max(0, Math.min(height - 1, Math.trunc((v[1] * height) / 999))),
  };
}

/** Parse the JSON verify answer (MCP-specific verification contract). */
export function parseVerifyAnswer(text: string): { pass: boolean; evidence: string } | null {
  // strip reasoning blocks — the verdict lives outside them
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/gi, " ");
  const jsonMatch = stripped.match(/\{[\s\S]*\}/);
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
  const yes = /\b(yes|true|是|通过)\b/i.test(stripped);
  const no = /\b(no|false|否|不通过|未)\b/i.test(stripped);
  if (yes !== no) return { pass: yes, evidence: stripped.trim().slice(0, 300) };
  return null;
}
