import { describe, expect, it } from "vitest";
import { TaskStateMachine, isTerminal } from "../../src/core/state-machine.js";
import { ComputerUseError } from "../../src/core/errors.js";

describe("task state machine (spec §36)", () => {
  it("walks the happy path", () => {
    const sm = new TaskStateMachine();
    sm.transition("OBSERVING");
    sm.transition("PLANNING");
    sm.transition("EXECUTING");
    sm.transition("VERIFYING");
    sm.transition("SUCCESS");
    expect(sm.state).toBe("SUCCESS");
    expect(sm.isTerminal()).toBe(true);
    // trail records CREATED + the 5 transitions
    expect(sm.trail.length).toBe(6);
  });

  it("allows recovery ladder", () => {
    const sm = new TaskStateMachine();
    sm.transition("OBSERVING");
    sm.transition("EXECUTING");
    sm.transition("RECOVERING");
    sm.transition("OBSERVING");
    sm.transition("PLANNING");
    sm.transition("LOCATING");
    sm.transition("EXECUTING");
    expect(sm.state).toBe("EXECUTING");
  });

  it("allows WAITING_CONFIRMATION and resume", () => {
    const sm = new TaskStateMachine();
    sm.transition("OBSERVING");
    sm.transition("PLANNING");
    sm.transition("WAITING_CONFIRMATION");
    sm.transition("EXECUTING");
    sm.transition("SUCCESS");
  });

  it("rejects illegal transitions", () => {
    const sm = new TaskStateMachine();
    expect(() => sm.transition("SUCCESS")).toThrow(ComputerUseError);
  });

  it("terminal states accept nothing further", () => {
    for (const terminal of ["SUCCESS", "FAILED", "BLOCKED", "CANCELLED"] as const) {
      const sm = new TaskStateMachine();
      sm.transition("OBSERVING");
      sm.transition("EXECUTING");
      sm.transition(terminal);
      expect(() => sm.transition("OBSERVING")).toThrow(ComputerUseError);
    }
  });

  it("isTerminal helper", () => {
    expect(isTerminal("SUCCESS")).toBe(true);
    expect(isTerminal("EXECUTING")).toBe(false);
  });
});
