/**
 * Cross-platform Automation DSL (spec §26) — YAML in, portable execution out.
 *
 * Scripts describe INTENT (semantic locators), not coordinates:
 *   点击名为"设置"的按钮 → locate {name: 设置}, action: click
 * The same script should run on any platform whose adapter can satisfy
 * the locators; a coordinate-based step is a last resort and marked as such.
 */
import { parse, stringify } from "yaml";
import { ComputerUseError } from "../core/errors.js";
import type { Action } from "../core/types-action.js";
import type { Target } from "../core/types.js";
import type { RecordEntry } from "../recorder/recorder.js";
import { ACTION_TYPES } from "../core/actions.js";

export interface DslLocator {
  role?: string;
  name?: string;
  text?: string;
  resourceId?: string;
  css?: string;
  xpath?: string;
  testId?: string;
  index?: number;
}

export interface DslStep {
  locate?: DslLocator;
  /** when omitted, the step is a pure wait */
  action?: string;
  value?: string | boolean | number;
  text?: string;
  key?: string | string[];
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
  durationMs?: number;
  /** wait until the located element (or locator target) appears before acting */
  waitBefore?: number;
  /** optional human description */
  description?: string;
}

export interface DslAssertion {
  element?: DslLocator;
  property: {
    checked?: boolean;
    exists?: boolean;
    valueEquals?: string;
    valueContains?: string;
    textVisible?: string;
  };
}

export interface DslScript {
  name: string;
  description?: string;
  target: Target & { app?: string };
  settings?: {
    stepTimeoutMs?: number;
    screenshotOnFailure?: boolean;
  };
  steps: DslStep[];
  assert?: DslAssertion[];
}

const KNOWN_ACTIONS = new Set<string>(ACTION_TYPES);

/** Parse + validate a YAML DSL script. */
export function parseDsl(yamlText: string): DslScript {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (e) {
    throw new ComputerUseError("invalid_request", `DSL YAML parse error: ${(e as Error).message}`);
  }
  return validateDsl(raw);
}

export function validateDsl(raw: unknown): DslScript {
  if (typeof raw !== "object" || raw === null) {
    throw new ComputerUseError("invalid_request", "DSL root must be a mapping");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== "string" || !obj.name) throw new ComputerUseError("invalid_request", "DSL requires a string `name`");
  const steps = obj.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new ComputerUseError("invalid_request", "DSL requires a non-empty `steps` list");
  }
  for (const [i, s] of steps.entries()) {
    const step = s as Record<string, unknown>;
    if (typeof step !== "object" || step === null) {
      throw new ComputerUseError("invalid_request", `steps[${i}] must be a mapping`);
    }
    if (step.action !== undefined) {
      if (typeof step.action !== "string" || !KNOWN_ACTIONS.has(step.action)) {
        throw new ComputerUseError(
          "invalid_request",
          `steps[${i}].action "${step.action}" is not a known unified action; known actions: ${[...KNOWN_ACTIONS].join(", ")}`,
        );
      }
    }
    if (step.locate !== undefined && (typeof step.locate !== "object" || step.locate === null)) {
      throw new ComputerUseError("invalid_request", `steps[${i}].locate must be a mapping`);
    }
  }
  const target = (obj.target ?? { type: "local", platform: "auto" }) as DslScript["target"];
  return {
    name: obj.name,
    description: typeof obj.description === "string" ? obj.description : undefined,
    target,
    settings: (obj.settings as DslScript["settings"]) ?? undefined,
    steps: steps as DslStep[],
    assert: (obj.assert as DslAssertion[]) ?? undefined,
  };
}

export function serializeDsl(script: DslScript): string {
  return stringify(script, { lineWidth: 120 });
}

/**
 * Recorder → DSL (spec §25): emit a portable script with semantic
 * locators. Coordinate-only actions are emitted with an explicit
 * `point`-style comment marker via `description` so users see they are
 * layout-fragile; the executor treats them as coordinates.
 */
export function recordToScript(entries: RecordEntry[], opts: { name: string; target: DslScript["target"]; description?: string }): DslScript {
  const steps: DslStep[] = [];
  for (const e of entries) {
    if (!e.ok) continue; // successful actions only — failed attempts are noise
    const a = e.action;
    switch (a.type) {
      case "click":
      case "double_click":
      case "right_click":
      case "long_press":
      case "toggle":
      case "invoke":
      case "select":
      case "set_value":
      case "clear": {
        const el = "element" in a ? a.element : undefined;
        if (el && el.source !== "vision") {
          const step: DslStep = {
            locate: locatorFromElement(el),
            action: a.type,
            description: `记录: ${e.actionSummary}`,
          };
          if (a.type === "set_value") step.value = a.value;
          if (a.type === "select" && a.value !== undefined) step.value = a.value;
          steps.push(step);
        } else if ("point" in a && a.point) {
          steps.push({
            action: a.type,
            description: `坐标步骤（脆弱，建议改成语义定位）: point=(${Math.round(a.point.x)},${Math.round(a.point.y)}) space=${a.point.space ?? "screenshot"} — ${e.actionSummary}`,
          });
        }
        break;
      }
      case "type": {
        steps.push({
          locate: a.element && a.element.source !== "vision" ? locatorFromElement(a.element) : undefined,
          action: "type",
          text: a.text,
          description: `记录: 输入文本`,
        });
        break;
      }
      case "press":
        steps.push({ action: "press", key: a.key });
        break;
      case "hotkey":
        steps.push({ action: "hotkey", key: a.keys });
        break;
      case "scroll":
        steps.push({ action: "scroll", direction: a.direction, amount: a.amount });
        break;
      case "launch_app":
        steps.push({ action: "launch_app", value: a.app });
        break;
      case "terminate_app":
        steps.push({ action: "terminate_app", value: a.app });
        break;
      case "focus":
        steps.push({ action: "focus", value: a.app ?? a.windowTitle });
        break;
      case "back":
      case "home":
        steps.push({ action: a.type });
        break;
      case "wait":
        steps.push({ action: "wait", durationMs: a.durationMs });
        break;
      default:
        break; // finish/fail/move/drag excluded from scripts
    }
  }
  return { name: opts.name, description: opts.description, target: opts.target, steps };
}

function locatorFromElement(el: { role?: string; name?: string; attributes?: Record<string, string | number | boolean | null> }): DslLocator {
  const loc: DslLocator = {};
  if (el.name) loc.name = el.name;
  if (el.role) loc.role = el.role;
  const rid = el.attributes?.["resource-id"];
  if (typeof rid === "string" && rid) loc.resourceId = rid;
  return loc;
}
