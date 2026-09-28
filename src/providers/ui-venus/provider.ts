/**
 * UI-Venus provider — the default ComputerVisionProvider (spec §19).
 * Talks to any OpenAI-compatible endpoint serving UI-Venus (e.g. the
 * W8A8 quantized vLLM deployment). Converts the model's [0,1000]
 * normalized coordinates into screenshot pixel space before returning,
 * using the observation's screenshot metadata.
 */
import type { VenusProviderConfig } from "../../config.js";
import type { Action } from "../../core/types-action.js";
import type { Observation, Point } from "../../core/types.js";
import { normalizedToScreenshot } from "../../coordinate/index.js";
import { ComputerUseError } from "../../core/errors.js";
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
import { VenusClient } from "./client.js";
import {
  agentSystemPrompt,
  agentUserPrompt,
  groundingPrompt,
  inspectPrompt,
  parseActionLine,
  parseAgentResponse,
  parseGroundingPoint,
  parseVerifyAnswer,
  verifyPrompt,
  type VenusActionCall,
} from "./prompts.js";

export class UiVenusProvider implements ComputerVisionProvider {
  readonly name = "ui-venus";
  private readonly client: VenusClient;

  constructor(private readonly cfg: VenusProviderConfig) {
    if (!cfg.apiKey) {
      throw new ComputerUseError("invalid_request", "VENUS_API_KEY is not configured", {
        hint: "Set VENUS_API_KEY in the environment or .env file",
      });
    }
    this.client = new VenusClient(cfg);
  }

  private requireScreenshot(obs: Observation): { dataBase64: string; mime: "image/png" | "image/jpeg" } {
    const shot = obs.screenshot;
    if (!shot) {
      throw new ComputerUseError(
        "unsupported",
        "Vision provider needs a screenshot, but the observation has none",
        { hint: "Check target capabilities; text-only targets cannot use the vision provider" },
      );
    }
    return { dataBase64: shot.dataBase64, mime: shot.format === "jpeg" ? "image/jpeg" : "image/png" };
  }

  /** Convert normalized [0,1000] to the observation's screenshot pixel space. */
  private toScreenshotSpace(p: Point, obs: Observation): Point {
    const shot = obs.screenshot;
    if (!shot) return p;
    return normalizedToScreenshot(p, shot.width, shot.height);
  }

  async locate(req: LocateRequest): Promise<LocateResult> {
    const img = this.requireScreenshot(req.observation);
    const raw = await this.client.chatWithImage(img.dataBase64, img.mime, groundingPrompt(req.instruction), {
      maxTokens: 32,
    });
    const parsed = parseGroundingPoint(raw);
    if (!parsed) {
      throw new ComputerUseError("provider_error", `Cannot parse grounding output: ${raw.slice(0, 120)}`);
    }
    if (!parsed.feasible) {
      return { source: "not_found", confidence: 0, raw };
    }
    const point = this.toScreenshotSpace({ x: parsed.x, y: parsed.y }, req.observation);
    return { source: "vision", point, normalized: { x: parsed.x, y: parsed.y }, confidence: 0.9, raw };
  }

  async decideNextAction(req: DecideRequest): Promise<DecideResult> {
    const img = this.requireScreenshot(req.observation);
    const recent = req.history.slice(-8).map((h) => ({
      index: h.index,
      summary: h.summary,
      ok: h.ok,
      error: h.error,
    }));
    const raw = await this.client.chatWithImage(img.dataBase64, img.mime, agentUserPrompt(req.goal, recent, req.language), {
      maxTokens: 512,
      messages: [{ role: "system", content: agentSystemPrompt() }],
    });
    const parsed = parseAgentResponse(raw);
    if (!parsed) {
      throw new ComputerUseError("provider_error", `Cannot parse agent output: ${raw.slice(0, 200)}`);
    }
    const call = parseActionLine(parsed.actionLine);
    if (!call) {
      throw new ComputerUseError("provider_error", `Cannot parse action line: ${parsed.actionLine.slice(0, 120)}`);
    }
    const { action, isFinal } = this.mapCall(call, req.observation);
    return {
      thought: parsed.thought,
      action,
      isFinal,
      confidence: 0.8,
      raw,
    };
  }

  async verify(req: VerifyRequest): Promise<VerifyResult> {
    const img = this.requireScreenshot(req.observation);
    const raw = await this.client.chatWithImage(img.dataBase64, img.mime, verifyPrompt(req.goal), {
      maxTokens: 128,
    });
    const parsed = parseVerifyAnswer(raw);
    if (!parsed) {
      throw new ComputerUseError("provider_error", `Cannot parse verify output: ${raw.slice(0, 160)}`);
    }
    return { pass: parsed.pass, source: "vision", evidence: parsed.evidence, confidence: 0.75, raw };
  }

  async inspect(req: InspectRequest): Promise<InspectResult> {
    const img = this.requireScreenshot(req.observation);
    const raw = await this.client.chatWithImage(img.dataBase64, img.mime, inspectPrompt(req.focus), {
      maxTokens: 1024,
    });
    return { description: raw.trim(), raw };
  }

  /** Map a parsed model call into a unified Action (coordinates → screenshot space). */
  private mapCall(call: VenusActionCall, obs: Observation): { action: Action; isFinal: boolean } {
    const toPoint = (x: number, y: number) => this.toScreenshotSpace({ x, y }, obs);
    switch (call.kind) {
      case "click":
        return { action: { type: "click", point: { ...toPoint(call.x, call.y), space: "screenshot" } }, isFinal: false };
      case "double_click":
        return { action: { type: "double_click", point: { ...toPoint(call.x, call.y), space: "screenshot" } }, isFinal: false };
      case "right_click":
        return { action: { type: "right_click", point: { ...toPoint(call.x, call.y), space: "screenshot" } }, isFinal: false };
      case "long_press":
        return { action: { type: "long_press", point: { ...toPoint(call.x, call.y), space: "screenshot" } }, isFinal: false };
      case "drag":
        return {
          action: {
            type: "drag",
            from: { point: { ...toPoint(call.from.x, call.from.y), space: "screenshot" } },
            to: { point: { ...toPoint(call.to.x, call.to.y), space: "screenshot" } },
          },
          isFinal: false,
        };
      case "type":
        return { action: { type: "type", text: call.text }, isFinal: false };
      case "hotkey":
        return { action: { type: "hotkey", keys: call.keys }, isFinal: false };
      case "scroll":
        return {
          action: {
            type: "scroll",
            direction: call.direction,
            amount: call.magnitude,
            point: { ...toPoint(call.x, call.y), space: "screenshot" },
          },
          isFinal: false,
        };
      case "wait":
        return { action: { type: "wait", durationMs: 1500 }, isFinal: false };
      case "finished":
        return { action: { type: "finish", status: "success" }, isFinal: true };
      case "fail":
        return { action: { type: "fail", reason: call.reason }, isFinal: true };
    }
  }
}
