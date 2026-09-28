/**
 * Pluggable computer-vision provider interface (spec §19).
 *
 * Providers are GUI experts: they see Observations + a Goal and answer
 * "where is it" (locate), "what next" (decideNextAction), "did it work"
 * (verify), "what's on screen" (inspect). They know nothing about MCP,
 * ZCode, or platform execution.
 */
import type { Action } from "../core/types-action.js";
import type { ElementRef, Observation, Point } from "../core/types.js";

export interface LocateRequest {
  /** natural-language element description, e.g. "关闭按钮" */
  instruction: string;
  observation: Observation;
}

export interface LocateResult {
  source: "vision" | "not_found";
  /** center point in screenshot pixel space (already converted from [0,1000]) */
  point?: Point;
  /** raw model output in [0,1000] normalized space, when available */
  normalized?: Point;
  confidence: number;
  raw: string;
}

export interface StepRecord {
  index: number;
  action: Action;
  ok: boolean;
  summary: string;
  /** screenshot hash after this step (stagnation context for the model) */
  screenHash?: string;
  error?: string;
  /**
   * Official multi-turn protocol (UI-Venus Computer): the accepted
   * assistant response ("<think>…</think>\n<action>…</action>") is appended
   * to the conversation history verbatim; rejected responses never are.
   */
  acceptedResponse?: string;
  /** the observation screenshot of this turn, for the last-N history images */
  screenshot?: { dataBase64: string; format: "png" | "jpeg" };
}

export interface DecideRequest {
  goal: string;
  observation: Observation;
  history: StepRecord[];
  /** language hint for thoughts, e.g. "en" | "zh" */
  language?: string;
}

export interface DecideResult {
  thought?: string;
  action: Action;
  /** open-loop Sequence children to execute after `action` (official Sequence) */
  sequence?: Action[];
  /** model believes the goal is complete */
  isFinal: boolean;
  /** CallUser → the task needs a human / is impossible */
  needsUser?: boolean;
  /** the accepted assistant response for history ("<think>…</think>\n<action>…</action>") */
  acceptedResponse?: string;
  summary?: string;
  confidence?: number;
  raw: string;
}

export interface VerifyRequest {
  goal: string;
  observation: Observation;
}

export interface VerifyResult {
  pass: boolean;
  /** which channel produced the verdict: the provider itself is "vision"; the orchestrator's structured checks use "structured" */
  source: "vision" | "structured";
  evidence: string;
  confidence: number;
  raw: string;
}

export interface InspectRequest {
  observation: Observation;
  focus?: string;
}

export interface InspectResult {
  description: string;
  elements?: ElementRef[];
  raw: string;
}

export interface ComputerVisionProvider {
  readonly name: string;
  locate(req: LocateRequest): Promise<LocateResult>;
  decideNextAction(req: DecideRequest): Promise<DecideResult>;
  verify(req: VerifyRequest): Promise<VerifyResult>;
  inspect(req: InspectRequest): Promise<InspectResult>;
}
