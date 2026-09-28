/**
 * Unified Action Schema (spec §17).
 *
 * One action vocabulary for every platform. Platform adapters translate
 * a generic action into native semantics:
 *   click(elementRef) → Windows: UIA Invoke · Android: UIAutomator tap ·
 *                       iOS: XCUITest tap · Browser: Playwright click ·
 *                       fallback: coordinate click
 */
import { z } from "zod";
import type { Action, ActionResult } from "./types-action.js";
import { ComputerUseError } from "./errors.js";

export type { Action, ActionResult };

const pointInSpaceSchema = z.object({
  x: z.number(),
  y: z.number(),
  space: z.enum(["normalized", "screenshot", "logical", "physical"]).optional(),
});

const elementRefSchema = z.object({
  id: z.string().min(1),
  source: z.enum(["uia", "atspi", "ax", "uiautomator", "xcuitest", "dom", "vision"]),
  role: z.string().optional(),
  name: z.string().optional(),
  value: z.string().optional(),
  description: z.string().optional(),
  bounds: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .optional(),
  clickable: z.boolean().optional(),
  editable: z.boolean().optional(),
  enabled: z.boolean().optional(),
  checked: z.boolean().optional(),
  selected: z.boolean().optional(),
  focused: z.boolean().optional(),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

const targetable = {
  element: elementRefSchema.optional(),
  point: pointInSpaceSchema.optional(),
};

const scrollDirection = z.enum(["up", "down", "left", "right"]);

/** Zod schema for the full unified action union — used by MCP tool inputs. */
export const actionSchema: z.ZodType<Action> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), ...targetable, button: z.enum(["left", "right"]).optional() }),
  z.object({ type: z.literal("double_click"), ...targetable }),
  z.object({ type: z.literal("long_press"), ...targetable, durationMs: z.number().int().positive().optional() }),
  z.object({ type: z.literal("right_click"), ...targetable }),
  z.object({ type: z.literal("move"), point: pointInSpaceSchema }),
  z.object({
    type: z.literal("drag"),
    from: z.object(targetable).optional(),
    to: z.object(targetable).optional(),
    durationMs: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("swipe"),
    from: z.object(targetable).optional(),
    to: z.object(targetable).optional(),
    durationMs: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("scroll"),
    direction: scrollDirection,
    amount: z.number().optional(),
    point: pointInSpaceSchema.optional(),
    element: elementRefSchema.optional(),
  }),
  z.object({
    type: z.literal("type"),
    text: z.string(),
    element: elementRefSchema.optional(),
    submit: z.boolean().optional(),
  }),
  z.object({ type: z.literal("set_value"), element: elementRefSchema, value: z.string() }),
  z.object({ type: z.literal("clear"), element: elementRefSchema.optional() }),
  z.object({ type: z.literal("press"), key: z.string(), element: elementRefSchema.optional() }),
  z.object({ type: z.literal("hotkey"), keys: z.array(z.string()).min(1) }),
  z.object({
    type: z.literal("select"),
    element: elementRefSchema,
    value: z.string().optional(),
    index: z.number().int().optional(),
  }),
  z.object({ type: z.literal("toggle"), element: elementRefSchema, value: z.boolean().optional() }),
  z.object({ type: z.literal("invoke"), element: elementRefSchema }),
  z.object({ type: z.literal("launch_app"), app: z.string().min(1) }),
  z.object({ type: z.literal("terminate_app"), app: z.string().min(1) }),
  z.object({
    type: z.literal("focus"),
    app: z.string().optional(),
    windowTitle: z.string().optional(),
    element: elementRefSchema.optional(),
  }),
  z.object({ type: z.literal("back") }),
  z.object({ type: z.literal("home") }),
  z.object({ type: z.literal("wait"), durationMs: z.number().int().min(0).max(120_000) }),
  z.object({
    type: z.literal("finish"),
    status: z.enum(["success", "failed"]),
    summary: z.string().optional(),
  }),
  z.object({ type: z.literal("fail"), reason: z.string().min(1) }),
]) as z.ZodType<Action>;

/** All action literals, for allowlist validation and docs. */
export const ACTION_TYPES = [
  "click",
  "double_click",
  "long_press",
  "right_click",
  "move",
  "drag",
  "swipe",
  "scroll",
  "type",
  "set_value",
  "clear",
  "press",
  "hotkey",
  "select",
  "toggle",
  "invoke",
  "launch_app",
  "terminate_app",
  "focus",
  "back",
  "home",
  "wait",
  "finish",
  "fail",
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

/** Validate an unknown object as a unified Action; throws ComputerUseError. */
export function parseAction(input: unknown): Action {
  const result = actionSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ComputerUseError("invalid_request", `Invalid action: ${issues}`);
  }
  // Cross-field check: pointer actions need a target.
  const a = result.data as Action;
  const needsTarget: ActionType[] = [
    "click",
    "double_click",
    "long_press",
    "right_click",
    "double_click",
  ];
  if (needsTarget.includes(a.type as ActionType) && !("element" in a && a.element) && !("point" in a && a.point)) {
    throw new ComputerUseError(
      "invalid_request",
      `Action "${a.type}" requires either "element" or "point"`,
    );
  }
  if ((a.type === "drag" || a.type === "swipe") && (!a.from || !a.to)) {
    throw new ComputerUseError("invalid_request", `Action "${a.type}" requires both "from" and "to"`);
  }
  return a;
}

/** True when the action carries its own target (element or point). */
export function hasTarget(a: Action): boolean {
  switch (a.type) {
    case "move":
    case "scroll":
      return "point" in a && !!a.point;
    case "click":
    case "double_click":
    case "long_press":
    case "right_click":
    case "type":
    case "clear":
    case "press":
      return Boolean(("element" in a && a.element) || ("point" in a && a.point));
    case "drag":
    case "swipe":
      return Boolean(a.from && a.to);
    case "set_value":
    case "select":
    case "toggle":
    case "invoke":
      return Boolean(a.element);
    default:
      return true; // system-level actions don't need a pointer target
  }
}

export function actionSummary(a: Action): string {
  switch (a.type) {
    case "click":
      return `click ${describe(a.element)}${a.point ? `@(${a.point.x},${a.point.y})` : ""}`;
    case "type":
      return `type "${truncate(a.text)}"`;
    case "press":
      return `press ${a.key}`;
    case "hotkey":
      return `hotkey ${a.keys.join("+")}`;
    case "scroll":
      return `scroll ${a.direction}`;
    case "launch_app":
      return `launch ${a.app}`;
    case "terminate_app":
      return `terminate ${a.app}`;
    case "finish":
      return `finish(${a.status})`;
    case "fail":
      return `fail: ${truncate(a.reason)}`;
    default:
      return a.type;
  }
}

function describe(e: { name?: string; role?: string } | undefined): string {
  if (!e) return "";
  const what = e.name ? `"${e.name}"` : (e.role ?? "element");
  return what;
}

function truncate(s: string, n = 40): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
