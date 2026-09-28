/**
 * Deterministic scripted provider for hermetic tests and CI.
 * Returns queued LocateResult/DecideResult/VerifyResult in order, with
 * sensible defaults, so the whole orchestrator pipeline runs offline.
 */
import type { Action } from "../../core/types-action.js";
import type { ElementRef, Point } from "../../core/types.js";
import type {
  ComputerVisionProvider,
  DecideRequest,
  DecideResult,
  InspectRequest,
  InspectResult,
  LocateRequest,
  LocateResult,
  VerifyRequest,
  VerifyResult,
} from "../types.js";

export interface MockProviderScript {
  locate?: LocateResult[];
  decide?: DecideResult[];
  verify?: VerifyResult[];
}

export function mockElement(overrides: Partial<ElementRef> = {}): ElementRef {
  return {
    id: "mock:btn-settings",
    source: "uia",
    role: "button",
    name: "设置",
    bounds: { x: 40, y: 40, width: 160, height: 48 },
    clickable: true,
    attributes: { process: "mockapp" },
    ...overrides,
  };
}

export function mockPointAt(bounds: { x: number; y: number; width: number; height: number }): Point {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

export class MockProvider implements ComputerVisionProvider {
  readonly name = "mock";
  calls: { locate: number; decide: number; verify: number; inspect: number } = {
    locate: 0,
    decide: 0,
    verify: 0,
    inspect: 0,
  };

  constructor(private script: MockProviderScript = {}) {}

  async locate(req: LocateRequest): Promise<LocateResult> {
    this.calls.locate++;
    const next = this.script.locate?.shift();
    if (next) return next;
    // default: not found
    return { source: "not_found", confidence: 0, raw: "mock: no locate script" };
  }

  async decideNextAction(req: DecideRequest): Promise<DecideResult> {
    this.calls.decide++;
    const next = this.script.decide?.shift();
    if (next) return next;
    return {
      thought: "mock default: finish",
      action: { type: "finish", status: "success", summary: "mock default finish" },
      isFinal: true,
      raw: "Action: finished()",
    };
  }

  async verify(req: VerifyRequest): Promise<VerifyResult> {
    this.calls.verify++;
    const next = this.script.verify?.shift();
    if (next) return next;
    return { pass: true, source: "vision", evidence: "mock default verify", confidence: 0.5, raw: "mock" };
  }

  async inspect(_req: InspectRequest): Promise<InspectResult> {
    this.calls.inspect++;
    return { description: "mock inspection: a deterministic mock screen", raw: "mock" };
  }
}

/** Convenience: a decide() script step that clicks an element by ref. */
export function decideClickElement(el: ElementRef, thought = "click the element"): DecideResult {
  return { thought, action: { type: "click", element: el }, isFinal: false, raw: "Action: click(el)" };
}

/** Convenience: a decide() script step that clicks a screenshot-space point. */
export function decideClickPoint(p: Point, thought = "click the point"): DecideResult {
  return { thought, action: { type: "click", point: { ...p, space: "screenshot" } }, isFinal: false, raw: `Action: click(${p.x}, ${p.y})` };
}

export function decideFinish(status: "success" | "failed" = "success", summary = "done"): DecideResult {
  return {
    thought: "goal achieved",
    action: { type: "finish", status, summary },
    isFinal: true,
    raw: "Action: finished()",
  };
}

export type { Action };
