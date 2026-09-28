/**
 * Cross-platform verifier (spec §23): structured assertions first, vision
 * last. Two entry points:
 *  - explicit assertions (DSL / structured hints) — deterministic
 *  - natural-language goal — heuristic structured check, then vision
 */
import type { ComputerVisionProvider, VerifyRequest, VerifyResult } from "../providers/types.js";
import type { Observation, UINode } from "../core/types.js";

export interface StructuredAssertion {
  /** element descriptor */
  element?: { name?: string; role?: string; resourceId?: string };
  /** expected property */
  property: {
    checked?: boolean;
    exists?: boolean;
    valueEquals?: string;
    valueContains?: string;
    textVisible?: string;
  };
}

export interface AssertionOutcome extends VerifyResult {
  source: "structured" | "vision";
  assertion?: StructuredAssertion;
}

function flatten(node: UINode): UINode[] {
  const out: UINode[] = [];
  const walk = (n: UINode): void => {
    out.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(node);
  return out;
}

/** Deterministic structured assertion against an observation's UI tree. */
export function checkStructuredAssertion(obs: Observation, a: StructuredAssertion): AssertionOutcome | null {
  if (!obs.uiTree) return null;
  const nodes = flatten(obs.uiTree);
  const desc = a.element ?? {};
  const candidates = nodes.filter((n) => {
    if (desc.name && !(n.name ?? "").toLowerCase().includes(desc.name.toLowerCase())) return false;
    if (desc.role && !(n.role ?? "").toLowerCase().includes(desc.role.toLowerCase())) return false;
    if (desc.resourceId && n.id !== desc.resourceId && n.attributes?.["resource-id"] !== desc.resourceId) return false;
    return true;
  });

  if (a.property.exists === false) {
    return candidates.length === 0
      ? { pass: true, source: "structured", evidence: `element ${desc.name ?? desc.resourceId} absent`, confidence: 1, raw: "structured" }
      : { pass: false, source: "structured", evidence: `element ${desc.name ?? desc.resourceId} still present`, confidence: 1, raw: "structured" };
  }
  if (candidates.length === 0) {
    return a.property.exists === true
      ? { pass: false, source: "structured", evidence: `element ${desc.name ?? desc.resourceId} not found`, confidence: 1, raw: "structured" }
      : null; // cannot evaluate further properties → let vision decide
  }
  const target = candidates[0]!;
  if (a.property.checked !== undefined) {
    const checked = typeof target.checked === "boolean" ? target.checked : target.value === "on";
    return checked === a.property.checked
      ? { pass: true, source: "structured", evidence: `"${target.name}" checked=${checked}`, confidence: 1, raw: "structured" }
      : { pass: false, source: "structured", evidence: `"${target.name}" checked=${checked}, expected ${a.property.checked}`, confidence: 1, raw: "structured" };
  }
  if (a.property.valueEquals !== undefined) {
    const ok = (target.value ?? "") === a.property.valueEquals;
    return {
      pass: ok,
      source: "structured",
      evidence: `"${target.name}" value="${target.value}"`,
      confidence: 1,
      raw: "structured",
    };
  }
  if (a.property.valueContains !== undefined) {
    const ok = (target.value ?? "").includes(a.property.valueContains);
    return { pass: ok, source: "structured", evidence: `"${target.name}" value="${target.value}"`, confidence: 1, raw: "structured" };
  }
  if (a.property.textVisible !== undefined) {
    const needle = a.property.textVisible.toLowerCase();
    const found = nodes.some(
      (n) => (n.name ?? "").toLowerCase().includes(needle) || (n.value ?? "").toLowerCase().includes(needle),
    );
    return { pass: found, source: "structured", evidence: `text "${a.property.textVisible}" ${found ? "visible" : "not visible"} in UI tree`, confidence: 1, raw: "structured" };
  }
  return null;
}

/**
 * Heuristic structured verification of a natural-language goal: looks for
 * toggle/checkbox keywords in the goal ("关闭自动更新") and checks their
 * state in the tree. Returns null when not applicable.
 */
export function heuristicVerify(obs: Observation, goal: string): VerifyResult | null {
  if (!obs.uiTree || !goal) return null;
  const lower = goal.toLowerCase();
  const wantsOff = /关闭|禁用|取消|disable|turn off|off\b/.test(lower);
  const wantsOn = /打开|开启|启用|enable|turn on|\bon\b/.test(lower);
  if (!wantsOff && !wantsOn) return null;
  const nodes = flatten(obs.uiTree);
  for (const n of nodes) {
    const role = (n.role ?? "").toLowerCase();
    if (!["checkbox", "switch", "toggle"].some((r) => role.includes(r))) continue;
    const name = (n.name ?? "").toLowerCase();
    if (!name) continue;
    // does the goal mention this control?
    const core = name.replace(/\s+/g, "");
    if (!lower.includes(core)) continue;
    const checked = typeof n.checked === "boolean" ? n.checked : n.value === "on";
    const pass = wantsOff ? !checked : checked;
    return {
      pass,
      source: "structured",
      evidence: `control "${n.name}" is ${checked ? "ON" : "OFF"}`,
      confidence: 0.9,
      raw: "heuristic",
    };
  }
  return null;
}

export class Verifier {
  constructor(private provider: ComputerVisionProvider) {}

  async verifyGoal(obs: Observation, goal: string): Promise<VerifyResult & { source: "structured" | "vision"; raw: string }> {
    // 1. structured heuristics — no model call when conclusive
    const heuristic = heuristicVerify(obs, goal);
    if (heuristic) return heuristic;

    // 2. vision verification
    if (!obs.screenshot) {
      return {
        pass: false,
        source: "structured",
        evidence: "cannot verify: no structured signal and no screenshot available",
        confidence: 0,
        raw: "",
      };
    }
    const req: VerifyRequest = { goal, observation: obs };
    const r = await this.provider.verify(req);
    return { pass: r.pass, evidence: r.evidence, confidence: r.confidence, source: "vision", raw: r.raw };
  }

  async verifyAssertion(obs: Observation, a: StructuredAssertion): Promise<AssertionOutcome> {
    const structured = checkStructuredAssertion(obs, a);
    if (structured) return structured;
    // structured channel unavailable → vision decides, but honestly labeled
    if (!obs.screenshot) {
      return {
        pass: false,
        source: "structured",
        evidence: "no UI tree available for structured assertion and no screenshot",
        confidence: 0,
        raw: "",
        assertion: a,
      };
    }
    const goalText = assertionToGoalText(a);
    const r = await this.provider.verify({ goal: goalText, observation: obs });
    return { pass: r.pass, evidence: r.evidence, confidence: r.confidence, source: "vision", raw: r.raw, assertion: a };
  }
}

function assertionToGoalText(a: StructuredAssertion): string {
  const el = a.element?.name ?? a.element?.resourceId ?? "the element";
  const p = a.property;
  if (p.checked !== undefined) return `${el} should be ${p.checked ? "checked/enabled" : "unchecked/disabled"}`;
  if (p.exists !== undefined) return `${el} should ${p.exists ? "exist" : "not exist"} on screen`;
  if (p.valueEquals !== undefined) return `${el} value should equal "${p.valueEquals}"`;
  if (p.valueContains !== undefined) return `${el} value should contain "${p.valueContains}"`;
  if (p.textVisible !== undefined) return `text "${p.textVisible}" should be visible`;
  return "the expected state should hold";
}
