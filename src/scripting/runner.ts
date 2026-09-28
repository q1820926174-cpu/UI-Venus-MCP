/**
 * DSL runner (spec §26): executes a portable script against a target.
 * Locator resolution is structure-first with vision fallback (fusion).
 */
import type { ServerConfig } from "../config.js";
import type { Action, ActionResult } from "../core/types-action.js";
import { ComputerUseError } from "../core/errors.js";
import type { Target } from "../core/types.js";
import type { ComputerVisionProvider } from "../providers/types.js";
import type { PlatformRouter } from "../platforms/router.js";
import { Recorder } from "../recorder/recorder.js";
import { FusionLocator } from "../orchestrator/locator.js";
import { Verifier } from "../orchestrator/verifier.js";
import { parseAction } from "../core/actions.js";
import type { DslScript, DslStep, DslAssertion } from "./dsl.js";

export interface DslRunOptions {
  script: DslScript;
  target?: Target;
  language?: string;
}

export interface DslStepResult {
  index: number;
  description?: string;
  ok: boolean;
  status: "PASS" | "FAIL" | "BLOCKED" | "SKIP";
  action?: string;
  summary: string;
  error?: string;
  durationMs: number;
}

export interface DslRunResult {
  script: string;
  status: "PASS" | "FAIL" | "BLOCKED" | "SKIP";
  steps: DslStepResult[];
  assertions: DslStepResult[];
  startedAt: number;
  finishedAt: number;
  recorder?: Record<string, unknown>;
  error?: string;
}

/** Resolve locator → element (structured first, vision fallback), then act. */
async function resolveStepAction(
  step: DslStep,
  locator: FusionLocator,
  adapter: import("../platforms/adapter.js").PlatformAdapter,
  obs: () => Promise<import("../core/types.js").Observation>,
): Promise<Action> {
  const type = step.action;
  if (!type) throw new ComputerUseError("invalid_request", "DSL step without action");
  const needsElement = [
    "click", "double_click", "right_click", "long_press", "toggle",
    "invoke", "select", "set_value", "clear", "type",
  ].includes(type);

  let element: import("../core/types.js").ElementRef | undefined;
  if (needsElement && step.locate) {
    const instruction = step.locate.name ?? step.locate.text ?? step.locate.resourceId ?? step.locate.css ?? JSON.stringify(step.locate);
    const res = await locator.locate(adapter, {
      instruction,
      descriptor: step.locate,
      observation: await obs(),
      preferStructured: true,
    });
    if (res.element) element = res.element;
    else if (res.point) {
      // vision-only: coordinate action
      return parseAction({ type, point: { ...res.point, space: "screenshot" }, ...(type === "type" ? { text: step.text ?? "" } : {}) });
    } else {
      throw new ComputerUseError("element_not_found", `Cannot locate ${JSON.stringify(step.locate)}`);
    }
  }

  const base: Record<string, unknown> = { type };
  if (element) base.element = element;
  switch (type) {
    case "set_value":
      base.value = String(step.value ?? "");
      break;
    case "select":
      if (step.value !== undefined) base.value = String(step.value);
      if (step.text !== undefined) base.value = step.text;
      break;
    case "type":
      base.text = step.text ?? "";
      break;
    case "press":
      base.key = step.key;
      break;
    case "hotkey":
      base.keys = Array.isArray(step.key) ? step.key : String(step.key ?? "").split("+").filter(Boolean);
      break;
    case "scroll":
      base.direction = step.direction ?? "down";
      base.amount = step.amount ?? 3;
      break;
    case "launch_app":
    case "terminate_app":
    case "focus":
      base.app = String(step.value ?? "");
      if (type === "focus" && !base.app) {
        delete base.app;
        base.windowTitle = step.text;
      }
      break;
    case "wait":
      base.durationMs = step.durationMs ?? 1000;
      break;
    default:
      break;
  }
  return parseAction(base);
}

export class DslRunner {
  private locator: FusionLocator;
  private verifier: Verifier;

  constructor(
    private readonly router: PlatformRouter,
    provider: ComputerVisionProvider,
    private readonly cfg: ServerConfig,
  ) {
    this.locator = new FusionLocator(provider);
    this.verifier = new Verifier(provider);
  }

  async run(opts: DslRunOptions): Promise<DslRunResult> {
    const startedAt = Date.now();
    const steps: DslStepResult[] = [];
    const assertions: DslStepResult[] = [];
    const target: Target = opts.target ?? (opts.script.target as Target);
    const session = await this.router.getSession(target, this.cfg.security);
    const adapter = session.adapter;
    const recorder = new Recorder(target);
    let status: DslRunResult["status"] = "PASS";
    let firstError: string | undefined;

    const observe = (options?: import("../platforms/adapter.js").ObserveOptions) => adapter.observe(options);

    for (const [i, step] of opts.script.steps.entries()) {
      const t0 = Date.now();
      try {
        if (step.waitBefore) await new Promise((r) => setTimeout(r, step.waitBefore));
        const action = await resolveStepAction(step, this.locator, adapter, observe);
        recorder.captureBefore((await observe({ includeScreenshot: true, includeUITree: false })).screenshot);
        const result: ActionResult = await adapter.executeAction(action);
        const afterShot = (await observe({ includeScreenshot: true, includeUITree: false })).screenshot;
        recorder.recordAction(action, result, { afterShot });
        steps.push({
          index: i,
          description: step.description,
          ok: result.ok,
          status: result.ok ? "PASS" : "FAIL",
          action: action.type,
          summary: JSON.stringify(step.locate ?? action.type),
          error: result.error?.message,
          durationMs: Date.now() - t0,
        });
        if (!result.ok) {
          status = "FAIL";
          firstError ??= result.error?.message;
          break; // fail fast; assertions skipped
        }
      } catch (e) {
        const err = e instanceof ComputerUseError ? e : new ComputerUseError("internal_error", (e as Error).message, { cause: e });
        const blocked = ["permission_required", "unsupported", "restricted", "device_offline", "device_not_found"].includes(err.code);
        steps.push({
          index: i,
          description: step.description,
          ok: false,
          status: blocked ? "BLOCKED" : "FAIL",
          action: step.action,
          summary: JSON.stringify(step.locate ?? step.action),
          error: err.message,
          durationMs: Date.now() - t0,
        });
        status = blocked ? "BLOCKED" : "FAIL";
        firstError = err.message;
        break;
      }
    }

    // assertions only when all steps passed
    if (status === "PASS" && opts.script.assert?.length) {
      const obs = await observe({ includeScreenshot: true, includeUITree: true });
      for (const [i, a] of opts.script.assert.entries()) {
        const t0 = Date.now();
        try {
          const outcome = await this.verifyAssertion(a, obs);
          assertions.push({
            index: i,
            ok: outcome.pass,
            status: outcome.pass ? "PASS" : "FAIL",
            summary: JSON.stringify(a.property),
            error: outcome.pass ? undefined : outcome.evidence,
            durationMs: Date.now() - t0,
          });
          if (!outcome.pass) status = "FAIL";
        } catch (e) {
          assertions.push({
            index: i,
            ok: false,
            status: "BLOCKED",
            summary: JSON.stringify(a.property),
            error: (e as Error).message,
            durationMs: Date.now() - t0,
          });
          status = "BLOCKED";
        }
      }
    }

    if (steps.length === 0) status = "SKIP";

    return {
      script: opts.script.name,
      status,
      steps,
      assertions,
      startedAt,
      finishedAt: Date.now(),
      recorder: recorder.toJSON(),
      error: firstError,
    };
  }

  private async verifyAssertion(a: DslAssertion, obs: import("../core/types.js").Observation) {
    return this.verifier.verifyAssertion(
      obs,
      {
        element: a.element ? { name: a.element.name, role: a.element.role, resourceId: a.element.resourceId } : undefined,
        property: a.property,
      },
    );
  }
}
