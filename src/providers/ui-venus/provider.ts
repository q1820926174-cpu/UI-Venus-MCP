/**
 * UI-Venus provider — the default ComputerVisionProvider.
 *
 * Implements the OFFICIAL UI-Venus-2 protocols (see prompts.ts header):
 *  - locate: official grounding (single-shot, thinking off, temp 0, [0,1000])
 *  - decideNextAction: official Computer agent protocol — official system
 *    prompt, <think>/<action> output, Python-call action grammar,
 *    0-999 coordinates, accepted-only multi-turn history with the last N
 *    screenshots, one same-messages retry on parse failure
 *  - verify/inspect: MCP-specific single-shot prompts
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
  StepRecord,
  VerifyRequest,
  VerifyResult,
} from "../types.js";
import { VenusClient, type ChatMessage } from "./client.js";
import {
  computerSystemPrompt,
  groundingPrompt,
  inspectPrompt,
  normalizedPoint999,
  parseActionCall,
  parseGroundingPoint,
  parseOfficialResponse,
  parseVerifyAnswer,
  verifyPrompt,
  type ComputerActionCall,
} from "./prompts.js";

export interface UiVenusAgentOptions {
  /** model card: agentic evals use 1.0 + reasoning; shipped example uses 0.0 */
  temperature?: number;
  enableThinking?: boolean;
  /** number of history screenshots appended to the multi-turn context */
  historyImages?: number;
  /** same-messages retry for unparseable actions (official default 1) */
  parseRetries?: number;
  sudoPassword?: string;
  maxTokens?: number;
}

export class UiVenusProvider implements ComputerVisionProvider {
  readonly name = "ui-venus";
  private readonly client: VenusClient;
  private readonly agent: Required<UiVenusAgentOptions>;

  constructor(
    private readonly cfg: VenusProviderConfig,
    agentOpts: UiVenusAgentOptions = {},
  ) {
    if (!cfg.apiKey) {
      throw new ComputerUseError("invalid_request", "VENUS_API_KEY is not configured", {
        hint: "Set VENUS_API_KEY in the environment or .env file",
      });
    }
    this.client = new VenusClient(cfg);
    this.agent = {
      // Model card (Inference Configuration): general agentic tasks use
      // temperature 1.0 with reasoning enabled and full reasoning history.
      temperature: agentOpts.temperature ?? Number(process.env.VENUS_AGENT_TEMPERATURE ?? "1.0"),
      enableThinking: agentOpts.enableThinking ?? (process.env.VENUS_AGENT_ENABLE_THINKING ?? "true").toLowerCase() !== "false",
      historyImages: agentOpts.historyImages ?? Number(process.env.VENUS_AGENT_HISTORY_IMAGES ?? "2"),
      parseRetries: agentOpts.parseRetries ?? 1,
      sudoPassword: agentOpts.sudoPassword ?? process.env.VENUS_SUDO_PASSWORD ?? "(not provided)",
      maxTokens: agentOpts.maxTokens ?? 4096,
    };
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

  private imagePart(mime: string, dataBase64: string, label: string) {
    return [
      { type: "text" as const, text: label },
      {
        type: "image_url" as const,
        min_pixels: this.cfg.minPixels,
        max_pixels: this.cfg.maxPixels,
        image_url: { url: `data:${mime};base64,${dataBase64}` },
      },
    ];
  }

  async locate(req: LocateRequest): Promise<LocateResult> {
    const img = this.requireScreenshot(req.observation);
    const raw = await this.client.chatWithImage(img.dataBase64, img.mime, groundingPrompt(req.instruction), {
      maxTokens: 32,
      temperature: 0,
      enableThinking: false,
    });
    const parsed = parseGroundingPoint(raw);
    if (!parsed) {
      throw new ComputerUseError("provider_error", `Cannot parse grounding output: ${raw.slice(0, 120)}`);
    }
    if (!parsed.feasible) {
      return { source: "not_found", confidence: 0, raw };
    }
    const point = this.toScreenshotSpace1000({ x: parsed.x, y: parsed.y }, req.observation);
    return { source: "vision", point, normalized: { x: parsed.x, y: parsed.y }, confidence: 0.9, raw };
  }

  /** [0,1000] grounding coordinates → screenshot pixel space. */
  private toScreenshotSpace1000(p: Point, obs: Observation): Point {
    const shot = obs.screenshot;
    if (!shot) return p;
    return normalizedToScreenshot(p, shot.width, shot.height);
  }

  /**
   * Official Computer agent turn (build_messages + parse_response +
   * normalize_action equivalents). Coordinates come back in screenshot
   * pixel space (converted with the official /999 rule against the
   * CURRENT screenshot size).
   */
  async decideNextAction(req: DecideRequest): Promise<DecideResult> {
    const img = this.requireScreenshot(req.observation);

    // Official build_messages: system + (history: user[History Screenshot]? + assistant) + user[Current Screenshot]
    const messages: ChatMessage[] = [
      { role: "system", content: computerSystemPrompt(req.goal, this.agent.sudoPassword) },
    ];
    const turns = req.history.filter((h) => h.acceptedResponse);
    const imageStart = Math.max(0, turns.length - Math.max(0, this.agent.historyImages));
    turns.forEach((turn, index) => {
      if (index >= imageStart && turn.screenshot) {
        messages.push({
          role: "user",
          content: this.imagePart(turn.screenshot.format === "jpeg" ? "image/jpeg" : "image/png", turn.screenshot.dataBase64, "History Screenshot:\n"),
        });
      } else {
        messages.push({ role: "user", content: "" });
      }
      messages.push({ role: "assistant", content: turn.acceptedResponse! });
    });
    messages.push({
      role: "user",
      content: this.imagePart(img.mime, img.dataBase64, "Current Screenshot:\n"),
    });

    // Official infer(): up to parse_retries+1 attempts with the SAME
    // messages; unparseable responses never enter history.
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.agent.parseRetries; attempt++) {
      const { content, reasoning } = await this.client.chat(messages, {
        temperature: this.agent.temperature,
        maxTokens: this.agent.maxTokens,
        enableThinking: this.agent.enableThinking,
      });
      let parsed: { thought: string; actionText: string };
      try {
        parsed = parseOfficialResponse(content, reasoning);
        const call = parseActionCall(parsed.actionText);
        const shot = req.observation.screenshot!;
        const { action, sequence, isFinal, needsUser } = this.mapCall(call, shot.width, shot.height);
        const think = parsed.thought ? `<think>${parsed.thought}</think>` : "";
        const acceptedResponse = [think, `<action>${parsed.actionText}</action>`].filter(Boolean).join("\n");
        return {
          thought: parsed.thought || undefined,
          action,
          sequence,
          isFinal,
          needsUser,
          acceptedResponse,
          confidence: 0.8,
          raw: content,
        };
      } catch (e) {
        lastError = e as Error;
      }
    }
    throw new ComputerUseError(
      "provider_error",
      `invalid action after ${this.agent.parseRetries + 1} attempts: ${lastError?.message}`,
      { cause: lastError ?? undefined },
    );
  }

  async verify(req: VerifyRequest): Promise<VerifyResult> {
    const img = this.requireScreenshot(req.observation);
    const raw = await this.client.chatWithImage(img.dataBase64, img.mime, verifyPrompt(req.goal), {
      maxTokens: 1024,
      temperature: 0,
      enableThinking: false,
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
      temperature: 0,
      enableThinking: false,
    });
    return { description: raw.trim(), raw };
  }

  /**
   * Official normalize_action equivalent: map a validated Computer action
   * call into unified Actions with pixel coordinates (official /999 rule).
   */
  private mapCall(
    call: ComputerActionCall,
    width: number,
    height: number,
  ): { action: Action; sequence?: Action[]; isFinal: boolean; needsUser: boolean } {
    const pt = (key: string): Point | undefined => {
      const v = call.args[key];
      if (!Array.isArray(v) || v.length !== 2) return undefined;
      return normalizedPoint999(v as [number, number], width, height);
    };
    const pixel = (p: Point) => ({ ...p, space: "screenshot" as const });

    switch (call.name) {
      case "Click":
      case "DoubleClick": {
        const p = pt("box");
        if (!p) {
          // Click() = "at current cursor position" — not trackable here
          throw new ComputerUseError(
            "unsupported",
            "Click() without box is not supported (cursor position unknown); pass box=(x, y)",
          );
        }
        return { action: { type: call.name === "Click" ? "click" : "double_click", point: pixel(p) }, isFinal: false, needsUser: false };
      }
      case "TripleClick":
      // unified schema has no triple-click; degrade to double-click (documented)
      case "MiddleClick":
      // unified schema has no middle button; degrade to left click (documented)
      {
        const p = pt("box");
        if (!p) throw new ComputerUseError("unsupported", `${call.name} requires box=(x, y)`);
        const type = call.name === "TripleClick" ? "double_click" : "click";
        return { action: { type, point: pixel(p) } as Action, isFinal: false, needsUser: false };
      }
      case "RightClick": {
        const p = pt("box");
        if (!p) throw new ComputerUseError("unsupported", "RightClick requires box=(x, y)");
        return { action: { type: "right_click", point: pixel(p) }, isFinal: false, needsUser: false };
      }
      case "Hover": {
        const p = pt("box")!;
        return { action: { type: "move", point: pixel(p) }, isFinal: false, needsUser: false };
      }
      case "Drag": {
        const end = pt("end")!;
        const start = pt("start");
        if (!start) {
          // no start → small move to end (cursor-position drags unsupported honestly)
          return { action: { type: "move", point: pixel(end) }, isFinal: false, needsUser: false };
        }
        return {
          action: { type: "drag", from: { point: pixel(start) }, to: { point: pixel(end) }, durationMs: 500 },
          isFinal: false,
          needsUser: false,
        };
      }
      case "Swipe": {
        const amount = call.args.amount as number;
        const axis = call.args.axis as string;
        const direction =
          axis === "vertical" ? (amount >= 0 ? "up" : "down") : amount >= 0 ? "right" : "left";
        const magnitude = Math.max(1, Math.min(10, Math.round(Math.abs(amount) / 400)));
        return { action: { type: "scroll", direction, amount: magnitude }, isFinal: false, needsUser: false };
      }
      case "Type": {
        const content = (call.args.content as string) ?? "";
        const submit = content.endsWith("\n");
        return {
          action: { type: "type", text: submit ? content.slice(0, -1) : content, submit },
          isFinal: false,
          needsUser: false,
        };
      }
      case "Hotkey": {
        const keys = call.args.keys as string[];
        const repeat = (call.args.repeat as number) ?? 1;
        const action: Action = { type: "hotkey", keys };
        if (repeat > 1) {
          // unified schema has no repeat; expand into a Sequence
          const rest: Action[] = Array.from({ length: repeat - 1 }, () => ({ type: "hotkey", keys }));
          return { action, sequence: rest, isFinal: false, needsUser: false };
        }
        return { action, isFinal: false, needsUser: false };
      }
      case "KeyDown":
      case "KeyUp":
      case "MouseDown":
      case "MouseUp":
        // held-input state machines are not representable in the unified
        // schema v1 — fail this step honestly; the model re-plans
        throw new ComputerUseError(
          "unsupported",
          `Computer action "${call.name}" (held input state) is not supported by the unified action schema yet`,
        );
      case "Wait":
        return { action: { type: "wait", durationMs: 1500 }, isFinal: false, needsUser: false };
      case "CallUser":
        return {
          action: { type: "fail", reason: `needs_user: ${(call.args.content as string) || "model requested human takeover"}` },
          isFinal: true,
          needsUser: true,
        };
      case "Finished":
        return {
          action: { type: "finish", status: "success", summary: (call.args.content as string) || undefined },
          isFinal: true,
          needsUser: false,
        };
      case "Sequence": {
        const children = call.children ?? [];
        if (children.length === 0) throw new ComputerUseError("provider_error", "Sequence without children");
        const mapped = children.map((c) => this.mapCall(c, width, height));
        const last = mapped[mapped.length - 1]!;
        return {
          action: mapped[0]!.action,
          sequence: mapped.slice(1).map((m) => m.action),
          isFinal: last.isFinal && last.action.type === "finish",
          needsUser: mapped.some((m) => m.needsUser),
        };
      }
      default:
        throw new ComputerUseError("provider_error", `unhandled Computer action: ${call.name}`);
    }
  }
}
