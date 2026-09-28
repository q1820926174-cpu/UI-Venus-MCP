/**
 * Unified task state machine (spec §36).
 * Legal transitions are explicit; anything else throws.
 */
import { ComputerUseError } from "./errors.js";

export type TaskState =
  | "CREATED"
  | "OBSERVING"
  | "PLANNING"
  | "LOCATING"
  | "EXECUTING"
  | "VERIFYING"
  | "RECOVERING"
  | "WAITING_CONFIRMATION"
  | "SUCCESS"
  | "FAILED"
  | "BLOCKED"
  | "CANCELLED";

export const TERMINAL_STATES: readonly TaskState[] = [
  "SUCCESS",
  "FAILED",
  "BLOCKED",
  "CANCELLED",
] as const;

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.includes(state);
}

const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  CREATED: ["OBSERVING", "WAITING_CONFIRMATION", "CANCELLED", "BLOCKED", "FAILED"],
  OBSERVING: ["PLANNING", "VERIFYING", "EXECUTING", "RECOVERING", "WAITING_CONFIRMATION", "CANCELLED", "FAILED", "BLOCKED", "SUCCESS"],
  PLANNING: ["LOCATING", "EXECUTING", "VERIFYING", "RECOVERING", "WAITING_CONFIRMATION", "CANCELLED", "FAILED", "BLOCKED", "SUCCESS"],
  LOCATING: ["EXECUTING", "RECOVERING", "PLANNING", "OBSERVING", "WAITING_CONFIRMATION", "CANCELLED", "FAILED", "BLOCKED", "SUCCESS"],
  EXECUTING: ["VERIFYING", "OBSERVING", "RECOVERING", "PLANNING", "WAITING_CONFIRMATION", "CANCELLED", "FAILED", "BLOCKED", "SUCCESS"],
  VERIFYING: ["SUCCESS", "FAILED", "RECOVERING", "OBSERVING", "PLANNING", "EXECUTING", "WAITING_CONFIRMATION", "CANCELLED", "BLOCKED"],
  RECOVERING: ["OBSERVING", "PLANNING", "LOCATING", "EXECUTING", "FAILED", "BLOCKED", "CANCELLED", "SUCCESS"],
  WAITING_CONFIRMATION: ["EXECUTING", "PLANNING", "CANCELLED", "FAILED", "BLOCKED"],
  SUCCESS: [],
  FAILED: [],
  BLOCKED: [],
  CANCELLED: [],
};

export class TaskStateMachine {
  private _state: TaskState = "CREATED";
  /** history of (state, at) pairs for evidence */
  readonly trail: { state: TaskState; at: number; note?: string }[] = [
    { state: "CREATED", at: Date.now() },
  ];

  get state(): TaskState {
    return this._state;
  }

  transition(next: TaskState, note?: string): TaskState {
    if (next === this._state) return this._state;
    const allowed = TRANSITIONS[this._state];
    if (!allowed.includes(next)) {
      throw new ComputerUseError(
        "internal_error",
        `Illegal task state transition ${this._state} → ${next}`,
        { details: { allowed } },
      );
    }
    this._state = next;
    this.trail.push({ state: next, at: Date.now(), note });
    return next;
  }

  isTerminal(): boolean {
    return isTerminal(this._state);
  }
}
