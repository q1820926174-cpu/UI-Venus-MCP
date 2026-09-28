/**
 * Action & result types (spec §17). Kept separate from types.ts so the
 * zod schema in actions.ts and platform adapters can import without cycles.
 */
import type { ElementRef, PointInSpace } from "./types.js";

export type Action =
  | { type: "click"; element?: ElementRef; point?: PointInSpace; button?: "left" | "right" }
  | { type: "double_click"; element?: ElementRef; point?: PointInSpace }
  | { type: "long_press"; element?: ElementRef; point?: PointInSpace; durationMs?: number }
  | { type: "right_click"; element?: ElementRef; point?: PointInSpace }
  | { type: "move"; point: PointInSpace }
  | {
      type: "drag";
      from?: { element?: ElementRef; point?: PointInSpace };
      to?: { element?: ElementRef; point?: PointInSpace };
      durationMs?: number;
    }
  | {
      type: "swipe";
      from?: { element?: ElementRef; point?: PointInSpace };
      to?: { element?: ElementRef; point?: PointInSpace };
      durationMs?: number;
    }
  | {
      type: "scroll";
      direction: "up" | "down" | "left" | "right";
      amount?: number;
      point?: PointInSpace;
      element?: ElementRef;
    }
  | { type: "type"; text: string; element?: ElementRef; submit?: boolean }
  | { type: "set_value"; element: ElementRef; value: string }
  | { type: "clear"; element?: ElementRef }
  | { type: "press"; key: string; element?: ElementRef }
  | { type: "hotkey"; keys: string[] }
  | { type: "select"; element: ElementRef; value?: string; index?: number }
  | { type: "toggle"; element: ElementRef; value?: boolean }
  | { type: "invoke"; element: ElementRef }
  | { type: "launch_app"; app: string }
  | { type: "terminate_app"; app: string }
  | { type: "focus"; app?: string; windowTitle?: string; element?: ElementRef }
  | { type: "back" }
  | { type: "home" }
  | { type: "wait"; durationMs: number }
  | { type: "finish"; status: "success" | "failed"; summary?: string }
  | { type: "fail"; reason: string };

/** How an action was actually executed — for evidence and QA. */
export type ExecutionMethod = "semantic" | "coordinate" | "system";

export interface ActionResult {
  ok: boolean;
  method: ExecutionMethod;
  /** element actually used (after fusion), if any */
  element?: ElementRef;
  /** final point used, in screenshot pixel space of the acted-on observation */
  point?: { x: number; y: number };
  error?: { code: string; message: string; hint?: string };
  durationMs: number;
  /** free-form platform detail (e.g. invoked UIA pattern name) */
  detail?: string;
}
