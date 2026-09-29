/**
 * Fusion locator (spec §4/§21): structured semantics first, vision as
 * fallback — and when vision produces a point, try to re-attach it to a
 * structured element so the ACTION still executes semantically.
 */
import type { ComputerVisionProvider, LocateRequest, LocateResult } from "../providers/types.js";
import type { ElementRef, Observation, UINode } from "../core/types.js";
import { distance, pointInRect, rectCenter } from "../coordinate/index.js";
import type { PlatformAdapter } from "../platforms/adapter.js";

export interface FusionLocateRequest {
  /** natural language element description, e.g. "关闭按钮" */
  instruction: string;
  /** optional explicit structured descriptor (from a calling agent) */
  descriptor?: {
    role?: string;
    name?: string;
    text?: string;
    resourceId?: string;
    css?: string;
    xpath?: string;
    testId?: string;
    index?: number;
  };
  observation: Observation;
  /** structured-first when true (default); false forces vision */
  preferStructured?: boolean;
}

export interface FusionLocateResult {
  source: "structured" | "vision" | "not_found";
  element?: ElementRef;
  point?: { x: number; y: number };
  /** raw model output in [0,1000] normalized space, when available */
  normalized?: { x: number; y: number };
  confidence: number;
  raw: string;
}

/** Extract candidate name tokens from a natural-language instruction. */
export function nameTokens(instruction: string): string[] {
  const cleaned = instruction
    .replace(/[，。！？、：；"“”'（）()\[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return [];
  const tokens = cleaned.split(" ").filter((t) => t.length > 0);
  // whole instruction as one token helps CJK (no spaces)
  return [...new Set([cleaned, ...tokens])];
}

/** Heuristic role extraction from NL ("按钮"/"checkbox"/"输入框"...). */
export function roleFromInstruction(instruction: string): string | undefined {
  const lower = instruction.toLowerCase();
  const table: [RegExp, string][] = [
    [/checkbox|复选框|勾选/, "checkbox"],
    [/switch|开关/, "switch"],
    [/button|按钮/, "button"],
    [/link|链接/, "link"],
    [/input|输入框|文本框|text ?field|search/, "textfield"],
    [/menu|菜单/, "menu"],
    [/tab|标签页/, "tab"],
    [/slider|滑块/, "slider"],
  ];
  for (const [re, role] of table) if (re.test(lower)) return role;
  return undefined;
}

function sharesCjkChar(a: string, b: string): boolean {
  for (const ch of a) if (/[\u4e00-\u9fa5]/.test(ch) && b.includes(ch)) return true;
  return false;
}

function nodeToElement(node: UINode): ElementRef {
  const { children: _children, ...el } = node;
  return el;
}

function flattenTree(node: UINode): UINode[] {
  const out: UINode[] = [];
  const walk = (n: UINode): void => {
    out.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(node);
  return out;
}

/** Structured matching: name-token containment + optional role filter. */
export function matchStructured(
  observation: Observation,
  instruction: string,
  roleHint?: string,
): ElementRef | null {
  if (!observation.uiTree) return null;
  const nodes = flattenTree(observation.uiTree);
  const tokens = nameTokens(instruction);
  const scored: { el: ElementRef; score: number }[] = [];
  for (const node of nodes) {
    const name = (node.name ?? "").toLowerCase();
    const value = (node.value ?? "").toLowerCase();
    const desc = (node.description ?? "").toLowerCase();
    if (!name && !value && !desc) continue;
    let best = 0;
    for (const t of tokens) {
      const tt = t.toLowerCase();
      if (!tt) continue;
      if (name === tt) best = Math.max(best, 100);
      else if (name.includes(tt) || tt.includes(name)) best = Math.max(best, name.length > 0 ? 60 : 0);
      else if (/^[\u4e00-\u9fa5]{1,4}$/.test(tt) && name.length > 0 && name.length <= 4 && sharesCjkChar(name, tt)) {
        best = Math.max(best, 55); // 乘号↔乘以, 等号↔等于
      }
      if (value.includes(tt) || desc.includes(tt)) best = Math.max(best, 40);
    }
    if (best === 0) continue;
    let score = best;
    if (roleHint) {
      const roleLower = (node.role ?? "").toLowerCase();
      if (roleLower.includes(roleHint.toLowerCase())) score += 50;
      else score -= 20;
    }
    // interactive elements dominate: a heading that MENTIONS the target
    // must never outrank the button/input that IS the target
    const interactive = node.clickable || node.editable || /^(button|textfield|checkbox|switch|combobox|link|tab|menuitem|listitem)$/i.test(node.role ?? "");
    if (interactive) score += 40;
    else if (best < 100) score -= 60; // partial text match on non-interactive → demote hard
    if (score > 0) scored.push({ el: nodeToElement(node), score });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  return scored[0]!.el;
}

/**
 * Try to re-attach a vision point to the nearest structured element whose
 * bounds contain the point (or are within `maxSnap` px of its center).
 * This is the heart of "vision locates, semantics execute".
 */
export function snapToStructuredElement(
  observation: Observation,
  point: { x: number; y: number },
  maxSnap = 24,
): ElementRef | null {
  if (!observation.uiTree) return null;
  const nodes = flattenTree(observation.uiTree).filter((n) => n.bounds);
  const interactive = (n: UINode): boolean =>
    n.clickable || n.editable ||
    /^(button|textfield|textarea|checkbox|switch|combobox|link|tab|menuitem|listitem|document|edit)$/i.test(n.role ?? "");
  let bestI: { el: ElementRef; d: number } | null = null;
  for (const node of nodes) {
    // never snap a click onto a static label/heading — fall through to the
    // model's own coordinates instead of mis-aiming "precisely"
    if (!interactive(node)) continue;
    const b = node.bounds!;
    let d: number;
    if (pointInRect(point, b)) d = distance(point, rectCenter(b));
    else {
      d = distance(point, rectCenter(b));
      if (d > maxSnap + Math.min(b.width, b.height) / 2) continue;
    }
    if (!bestI || d < bestI.d) bestI = { el: nodeToElement(node), d };
  }
  return bestI?.el ?? null;
}

export class FusionLocator {
  constructor(private provider: ComputerVisionProvider) {}

  async locate(adapter: PlatformAdapter, req: FusionLocateRequest): Promise<FusionLocateResult> {
    const preferStructured = req.preferStructured !== false;

    // 1. explicit structured descriptor → adapter locator (UIA/AX/DOM/AT-SPI...)
    if (preferStructured && req.descriptor) {
      try {
        const hit = await adapter.locate(req.descriptor);
        if (hit) {
          return { source: "structured", element: hit.element, confidence: 0.95, raw: "adapter.locate" };
        }
      } catch {
        /* structured path broken → fall through to vision (spec §44) */
      }
    }

    // 2. heuristic structured match on the observation tree
    if (preferStructured && req.observation.uiTree) {
      const roleHint = req.descriptor?.role ?? roleFromInstruction(req.instruction);
      const el = matchStructured(req.observation, req.instruction, roleHint);
      if (el) return { source: "structured", element: el, confidence: 0.8, raw: "tree match" };
    }

    // 3. vision grounding
    if (!req.observation.screenshot) {
      return { source: "not_found", confidence: 0, raw: "no screenshot and no structured match" };
    }
    const visionReq: LocateRequest = { instruction: req.instruction, observation: req.observation };
    let vision: LocateResult;
    try {
      vision = await this.provider.locate(visionReq);
    } catch (e) {
      return { source: "not_found", confidence: 0, raw: `vision failed: ${(e as Error).message}` };
    }
    if (vision.source === "not_found" || !vision.point) {
      return { source: "not_found", confidence: 0, raw: vision.raw };
    }

    // 4. fusion: snap vision point onto a structured element when possible
    const snapped = snapToStructuredElement(req.observation, vision.point);
    if (snapped) {
      return {
        source: "structured",
        element: snapped,
        point: vision.point,
        confidence: Math.max(vision.confidence, 0.85),
        raw: `vision point snapped to structured element "${snapped.name ?? snapped.id}"`,
      };
    }
    return { source: "vision", point: vision.point, normalized: vision.normalized, confidence: vision.confidence, raw: vision.raw };
  }
}
