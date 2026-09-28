/**
 * Task orchestrator (spec §22/§32/§35/§36).
 *
 * Modes:
 *  - delegate: full autonomous loop (observe → decide → locate/execute →
 *    verify → recover), for text-only / non-visual agents.
 *  - auto: same loop, but the fusion locator prefers structured channels
 *    per-step and falls back to vision (identical loop, different strategy
 *    bias — kept explicit for spec §3 clarity).
 *  - assist / direct are tool-level modes (computer_inspect/locate/action)
 *    and don't enter this loop.
 *
 * Guarantees: state machine transitions, security confirmations,
 * stagnation guard, honest BLOCKED vs FAILED, cancellation.
 */
import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../config.js";
import { ComputerUseError } from "../core/errors.js";
import { TaskStateMachine, type TaskState } from "../core/state-machine.js";
import type { Action, ActionResult } from "../core/types-action.js";
import type { ElementRef, Observation, Target } from "../core/types.js";
import type { ComputerVisionProvider, StepRecord } from "../providers/types.js";
import type { PlatformRouter, Session } from "../platforms/router.js";
import { actionSummary, hasTarget, parseAction } from "../core/actions.js";
import { evaluateAction, ConfirmationRegistry, type SecurityConfig } from "./security.js";
import { LoopGuard } from "./loop-guard.js";
import { FusionLocator } from "./locator.js";
import { Verifier } from "./verifier.js";

export type TaskMode = "delegate" | "assist" | "direct" | "auto";

export interface TaskRecord {
  id: string;
  goal: string;
  target: Target;
  mode: TaskMode;
  language?: string;
  maxSteps: number;
  state: TaskState;
  steps: (StepRecord & { result?: ActionResult })[];
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  outcome?: {
    status: "SUCCESS" | "FAILED" | "BLOCKED" | "CANCELLED";
    reason?: string;
    evidence?: string;
    verify?: { pass: boolean; source: string; evidence: string };
  };
  pendingConfirmation?: { token: string; reason: string };
  error?: { code: string; message: string; hint?: string };
}

export interface ExecuteTaskOptions {
  target: Target;
  goal: string;
  mode?: TaskMode;
  language?: string;
  maxSteps?: number;
  /** run synchronously and wait for completion (default false → background) */
  wait?: boolean;
  /** confirm a previously parked sensitive action */
  confirmToken?: string;
  security?: SecurityConfig;
}

export class TaskOrchestrator {
  private tasks = new Map<string, { record: TaskRecord; sm: TaskStateMachine; cancelRequested: boolean; runner?: Promise<TaskRecord> }>();
  readonly confirmations = new ConfirmationRegistry();

  constructor(
    private readonly router: PlatformRouter,
    private readonly provider: ComputerVisionProvider,
    private readonly cfg: ServerConfig,
  ) {}

  listTasks(): TaskRecord[] {
    return [...this.tasks.values()].map((t) => ({ ...t.record }));
  }

  getTask(id: string): TaskRecord | undefined {
    return this.tasks.get(id)?.record;
  }

  cancelTask(id: string): boolean {
    const t = this.tasks.get(id);
    if (!t) return false;
    t.cancelRequested = true;
    if (t.record.state === "WAITING_CONFIRMATION" && t.record.pendingConfirmation) {
      this.confirmations.cancel(t.record.pendingConfirmation.token);
    }
    return true;
  }

  async executeTask(opts: ExecuteTaskOptions): Promise<TaskRecord> {
    if (!opts.goal || !opts.goal.trim()) {
      throw new ComputerUseError("invalid_request", "executeTask requires a non-empty `goal`", {
        hint: "The MCP tool computer_execute_task maps its `task` argument to `goal`.",
      });
    }
    const id = randomUUID().slice(0, 8);
    const mode = opts.mode ?? "auto";
    const record: TaskRecord = {
      id,
      goal: opts.goal,
      target: opts.target,
      mode,
      language: opts.language,
      maxSteps: opts.maxSteps ?? this.cfg.orchestrator.maxSteps,
      state: "CREATED",
      steps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const sm = new TaskStateMachine();
    const entry: { record: TaskRecord; sm: TaskStateMachine; cancelRequested: boolean; runner?: Promise<TaskRecord> } = {
      record,
      sm,
      cancelRequested: false,
    };
    this.tasks.set(id, entry);

    // Confirmation fast-path: resume a parked action.
    if (opts.confirmToken) {
      const ok = this.confirmations.confirm(opts.confirmToken);
      if (!ok) {
        record.state = "FAILED";
        record.outcome = { status: "FAILED", reason: "invalid or expired confirmation token" };
        return record;
      }
    }

    const runner = this.runLoop(entry, opts).catch((e: unknown) => {
      const err = e instanceof ComputerUseError ? e : new ComputerUseError("internal_error", (e as Error).message, { cause: e });
      const blockedCodes = ["permission_required", "restricted", "unsupported", "device_offline", "device_not_found"];
      record.state = blockedCodes.includes(err.code) ? "BLOCKED" : "FAILED";
      record.error = { code: err.code, message: err.message, hint: err.hint };
      record.outcome = { status: record.state === "BLOCKED" ? "BLOCKED" : "FAILED", reason: err.message };
      record.finishedAt = Date.now();
      return record;
    });
    entry.runner = runner;

    if (opts.wait) return runner;
    return record;
  }

  private async runLoop(
    entry: { record: TaskRecord; sm: TaskStateMachine; cancelRequested: boolean },
    opts: ExecuteTaskOptions,
  ): Promise<TaskRecord> {
    const { record, sm } = entry;
    const security = opts.security ?? this.cfg.security;
    const deadline = Date.now() + this.cfg.orchestrator.taskTimeoutMs;
    const guard = new LoopGuard({
      ...{
        sameScreenDistance: 4,
        maxRepeatedFailures: 3,
      },
      maxStagnation: this.cfg.orchestrator.maxStagnation,
    });
    const locator = new FusionLocator(this.provider);
    const verifier = new Verifier(this.provider);

    const session = await this.router.getSession(opts.target, security);
    sm.transition("OBSERVING", "session ready");
    record.state = sm.state;

    let recoveries = 0;
    let stepIndex = 0;

    while (stepIndex < record.maxSteps) {
      if (entry.cancelRequested) {
        sm.transition("CANCELLED", "cancelled by caller");
        record.state = sm.state;
        record.outcome = { status: "CANCELLED", reason: "cancelled by caller" };
        record.finishedAt = Date.now();
        return this.snapshot(entry);
      }
      if (Date.now() > deadline) {
        sm.transition("FAILED", "task timeout");
        record.state = sm.state;
        record.outcome = { status: "FAILED", reason: `task timeout after ${this.cfg.orchestrator.taskTimeoutMs}ms` };
        record.finishedAt = Date.now();
        return this.snapshot(entry);
      }

      // ---- observe (window-scoped: small UI stays legible for the vision model)
      const obs = await session.adapter.observe({ scope: "window" });
      record.state = sm.state;

      // ---- decide (delegate/auto both use the vision provider as GUI expert)
      sm.transition("PLANNING");
      const history: StepRecord[] = record.steps.map((s, i) => ({
        index: i,
        action: s.action,
        ok: s.ok,
        summary: s.summary,
        screenHash: s.screenHash,
        error: s.error,
      }));
      let decision;
      try {
        decision = await this.provider.decideNextAction({
          goal: opts.goal,
          observation: obs,
          history,
          language: opts.language,
        });
      } catch (e) {
        // Model produced an unparseable answer: feed the failure back as a
        // synthetic failed step and re-observe instead of failing the whole
        // task (spec §32 recovery ladder).
        recoveries++;
        if (recoveries > this.cfg.orchestrator.maxRecoveries) throw e;
        record.steps.push({
          index: stepIndex + 1,
          action: { type: "wait", durationMs: 0 },
          ok: false,
          summary: `model output rejected: ${(e as Error).message.slice(0, 160)}`,
          screenHash: obs.screenshot?.hash,
          error: (e as Error).message.slice(0, 200),
        });
        stepIndex++;
        sm.transition("RECOVERING", "re-querying after bad model output");
        record.state = sm.state;
        await new Promise((r) => setTimeout(r, 200));
        sm.transition("OBSERVING");
        record.state = sm.state;
        continue;
      }
      const action: Action = parseAction(decision.action);
      // Official accepted-only history: once the response parses, the
      // assistant turn (thought + action) and this turn's screenshot join
      // the multi-turn context for all future decide calls.
      const historyTurn: Partial<TaskRecord["steps"][number]> = {
        acceptedResponse: decision.acceptedResponse,
        screenshot: obs.screenshot ? { dataBase64: obs.screenshot.dataBase64, format: obs.screenshot.format } : undefined,
      };

      // ---- security gate
      const verdict = evaluateAction(action, security);
      if (verdict.verdict === "deny") {
        sm.transition("FAILED", "security deny");
        record.state = sm.state;
        record.outcome = { status: "FAILED", reason: `blocked by security policy: ${verdict.reason}` };
        record.finishedAt = Date.now();
        return this.snapshot(entry);
      }
      if (verdict.verdict === "confirm" && security.confirmSensitiveActions) {
        const token = this.confirmations.park(action, verdict.reason, security.confirmationTimeoutMs);
        sm.transition("WAITING_CONFIRMATION", verdict.reason);
        record.state = sm.state;
        record.pendingConfirmation = { token, reason: verdict.reason };
        record.updatedAt = Date.now();
        // park the loop; resume when confirm token arrives (executeTask called again)
        await this.confirmations.waitFor(token, security.confirmationTimeoutMs);
        record.pendingConfirmation = undefined;
        sm.transition("EXECUTING", "confirmed");
      }

      // ---- finish action → verify
      if (action.type === "finish" || action.type === "fail") {
        sm.transition("VERIFYING");
        const finalObs = action.type === "fail" ? obs : await session.adapter.observe({ scope: "window" });
        if (action.type === "fail") {
          sm.transition("FAILED", action.reason);
          record.state = sm.state;
          record.outcome = { status: "FAILED", reason: action.reason };
          record.finishedAt = Date.now();
          return this.snapshot(entry);
        }
        const verify = await verifier.verifyGoal(finalObs, opts.goal).catch((e: Error) => ({
          pass: false,
          source: "structured" as const,
          evidence: `verifier error: ${e.message}`,
          confidence: 0,
          raw: e.stack?.slice(0, 800) ?? "",
        }));
        record.outcome = {
          status: verify.pass ? "SUCCESS" : "FAILED",
          reason: verify.pass ? undefined : `model declared finished but verification failed: ${verify.evidence}`,
          evidence: verify.evidence,
          verify: { pass: verify.pass, source: verify.source, evidence: verify.evidence },
        };
        sm.transition(verify.pass ? "SUCCESS" : "FAILED");
        record.state = sm.state;
        record.finishedAt = Date.now();
        return this.snapshot(entry);
      }

      // ---- resolve target (fusion) for pointer/input actions
      sm.transition("LOCATING");
      let execAction: Action = action;
      if (!hasTarget(action) || action.type === "click" || action.type === "type" || action.type === "toggle") {
        if (needsElementResolution(action) && obs.uiTree) {
          const instruction = actionInstruction(action, decision.thought, opts.goal);
          const located = instruction
            ? await locator.locate(session.adapter, {
                instruction,
                observation: obs,
                preferStructured: record.mode === "auto",
              }).catch(() => null)
            : null;
          if (located?.element && located.source === "structured") {
            execAction = attachElement(action, located.element);
          } else if (hasPoint(action) && obs.uiTree) {
            // §21 fusion: the vision point is imprecise by design — snap it
            // onto the structured element under it and execute semantically
            const { snapToStructuredElement } = await import("./locator.js");
            const snapped = snapToStructuredElement(obs, toScreenshotPixels(action, obs));
            if (snapped?.bounds) {
              execAction = attachElement(action, snapped);
            }
          }
        }
      }

      // ---- execute
      sm.transition("EXECUTING");
      const result = await session.adapter.executeAction(execAction);
      const sequenceTail: Action[] = result.ok && decision.sequence?.length ? decision.sequence : [];
      for (const child of sequenceTail) {
        // official Sequence semantics: children execute open-loop; a
        // security deny or hard failure aborts the remainder
        const childVerdict = evaluateAction(child, security);
        if (childVerdict.verdict === "deny") {
          result.ok = false;
          result.error = { code: "security_blocked", message: childVerdict.reason };
          break;
        }
        const childResult = await session.adapter.executeAction(child);
        if (!childResult.ok) {
          result.ok = false;
          result.error = childResult.error;
          break;
        }
      }
      stepIndex++;
      const step: TaskRecord["steps"][number] = {
        index: stepIndex,
        action: execAction,
        ok: result.ok,
        summary: actionSummary(execAction),
        screenHash: obs.screenshot?.hash,
        error: result.error?.message,
        result,
        acceptedResponse: historyTurn.acceptedResponse,
        screenshot: historyTurn.screenshot,
      };
      record.steps.push(step);
      // bound memory: only the last few turns' screenshots are ever sent
      for (let i = 0; i < record.steps.length - 4; i++) record.steps[i]!.screenshot = undefined;
      record.updatedAt = Date.now();

      guard.record({
        index: stepIndex,
        actionType: execAction.type,
        actionSummary: step.summary,
        elementId: "element" in execAction ? execAction.element?.id : undefined,
        screenHash: obs.screenshot?.hash,
        treeDigest: treeDigest(obs.uiTree),
        ok: result.ok,
      });
      const stagnation = guard.evaluate();
      if (stagnation.stagnant) {
        recoveries++;
        if (stagnation.recovery === "give-up" || recoveries > this.cfg.orchestrator.maxRecoveries) {
          sm.transition("FAILED", "stagnation");
          record.state = sm.state;
          record.outcome = {
            status: "FAILED",
            reason: `stagnation detected: ${stagnation.reasons.join("; ")}`,
          };
          record.finishedAt = Date.now();
          return this.snapshot(entry);
        }
        sm.transition("RECOVERING", stagnation.reasons.join("; "));
        // recovery: brief pause; the next iteration re-observes. A history
        // note steers the model away from repeating the same move.
        record.steps.push({
          index: stepIndex,
          action: { type: "wait", durationMs: 300 },
          ok: true,
          summary: `recovery ${recoveries}/${this.cfg.orchestrator.maxRecoveries}: ${stagnation.reasons.join("; ")}`,
          screenHash: obs.screenshot?.hash,
        });
        await new Promise((r) => setTimeout(r, 300));
        sm.transition("OBSERVING", "re-observing after stagnation");
        continue;
      }

      // ---- per-step verification (spec §22 loop): structured heuristics
      // first (free), vision verdict only when structure can't answer.
      // A passing check finishes the task even when the model keeps going —
      // small models often re-issue the final action instead of Finished.
      if (result.ok && execAction.type !== "wait") {
        const postObs = await session.adapter.observe({ scope: "window" });
        const stepVerify = await verifier
          .verifyGoal(postObs, opts.goal)
          .catch(() => null);
        if (stepVerify?.pass) {
          sm.transition("VERIFYING", "per-step check");
          record.state = sm.state;
          record.outcome = {
            status: "SUCCESS",
            evidence: stepVerify.evidence,
            verify: { pass: true, source: stepVerify.source, evidence: stepVerify.evidence },
          };
          sm.transition("SUCCESS", "per-step verification passed");
          record.state = sm.state;
          record.finishedAt = Date.now();
          return this.snapshot(entry);
        }
      }

      if (!result.ok) {
        sm.transition("RECOVERING", result.error?.message);
        recoveries++;
        if (recoveries > this.cfg.orchestrator.maxRecoveries) {
          const code = result.error?.code ?? "internal_error";
          sm.transition(["permission_required", "restricted", "unsupported", "device_offline", "device_not_found"].includes(code) ? "BLOCKED" : "FAILED", result.error?.message);
          record.state = sm.state;
          record.outcome = { status: record.state === "BLOCKED" ? "BLOCKED" : "FAILED", reason: result.error?.message };
          record.finishedAt = Date.now();
          return this.snapshot(entry);
        }
        sm.transition("OBSERVING", "retry after failed action");
        continue;
      }

      sm.transition("OBSERVING", "step done");
    }

    sm.transition("FAILED", "max steps reached");
    record.state = sm.state;
    record.outcome = { status: "FAILED", reason: `max steps (${record.maxSteps}) reached without completion` };
    record.finishedAt = Date.now();
    return this.snapshot(entry);
  }

  private snapshot(entry: { record: TaskRecord; sm: TaskStateMachine }): TaskRecord {
    entry.record.state = entry.sm.state;
    entry.record.updatedAt = Date.now();
    return { ...entry.record };
  }
}

/** Stable digest of the structured UI state: leaf texts + values. */
function treeDigest(root: unknown): string | undefined {
  if (!root || typeof root !== "object") return undefined;
  const parts: string[] = [];
  const walk = (n: { role?: string; name?: string; value?: string; children?: unknown[] }, depth: number): void => {
    if (depth > 14 || parts.length > 240) return;
    const leaf = !n.children || n.children.length === 0;
    if (leaf && (n.name || n.value)) parts.push(`${n.role ?? ""}:${n.name ?? ""}=${n.value ?? ""}`);
    for (const c of (n.children ?? []) as { role?: string; name?: string; value?: string; children?: unknown[] }[]) walk(c, depth + 1);
  };
  walk(root as never, 0);
  if (parts.length === 0) return undefined;
  let h = 5381;
  const joined = parts.join("|");
  for (let i = 0; i < joined.length; i++) h = ((h * 33) ^ joined.charCodeAt(i)) >>> 0;
  return `t${h.toString(36)}`;
}

function hasPoint(action: Action): boolean {
  return "point" in action && !!action.point;
}

/** Vision/normalized point → screenshot pixel space against this observation. */
function toScreenshotPixels(action: Action, obs: import("../core/types.js").Observation): { x: number; y: number } {
  const p = (action as { point?: { x: number; y: number; space?: string } }).point!;
  if (!obs.screenshot) return { x: p.x, y: p.y };
  if (!p.space || p.space === "screenshot") return { x: p.x, y: p.y };
  const shot = obs.screenshot;
  if (p.space === "normalized") {
    return { x: (p.x / 1000) * shot.width, y: (p.y / 1000) * shot.height };
  }
  // logical/physical → screenshot: undo origin, apply scale
  const scale = shot.scale > 0 ? shot.scale : 1;
  return { x: (p.x - shot.origin.x) * scale, y: (p.y - shot.origin.y) * scale };
}

function needsElementResolution(action: Action): boolean {
  if (action.type === "click" || action.type === "double_click" || action.type === "right_click" || action.type === "long_press") {
    return !("element" in action && action.element);
  }
  if (action.type === "toggle" || action.type === "invoke" || action.type === "select" || action.type === "set_value") {
    return false; // model provided element refs or they came from locate
  }
  return false;
}

/** Build the locate instruction: the GOAL text carries the cleanest semantic
 *  tokens (点击 7、乘号…); the model thought is a fallback. */
function actionInstruction(action: Action, thought?: string, goal?: string): string | undefined {
  if (action.type === "type") return undefined;
  // the model's thought names the IMMEDIATE target ("现在点击乘号") —
  // far more specific than the whole goal (whose tokens would re-resolve
  // to the first mentioned element every step)
  if (thought && thought.trim().length > 0) return thought.trim();
  if (goal && goal.trim().length > 0) return goal.trim();
  return undefined;
}

function attachElement(action: Action, el: ElementRef): Action {
  switch (action.type) {
    case "click":
      return { ...action, element: el, point: action.point };
    case "double_click":
    case "right_click":
    case "long_press":
    case "type":
    case "toggle":
    case "invoke":
      return { ...action, element: el };
    default:
      return action;
  }
}
