/**
 * UI-Venus HTTP client — OpenAI-compatible chat/completions with vision
 * content. Verified against UI-Venus-2-9B-W8A8 served by vLLM:
 *
 *   POST {baseUrl}/chat/completions
 *   { model, temperature: 0, max_tokens,
 *     chat_template_kwargs: { enable_thinking: false },
 *     messages: [{ role: "user", content: [
 *       { type: "image_url", min_pixels, max_pixels,
 *         image_url: { url: "data:image/png;base64,..." } },
 *       { type: "text", text: "..." } ] }] }
 *
 * The model outputs coordinates in [0,1000] normalized space (empirically
 * calibrated: a button at pixel (1300,740) on 1920×1080 → [676,680]).
 */
import type { VenusProviderConfig } from "../../config.js";
import { ComputerUseError } from "../../core/errors.js";

export type ChatContentPart =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      min_pixels?: number;
      max_pixels?: number;
      image_url: { url: string };
    };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ChatContentPart[];
}

export interface ChatResult {
  content: string;
  /** vLLM reasoning_content when the reasoning parser is enabled */
  reasoning: string;
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  enableThinking?: boolean;
  retries?: number;
}

export class VenusClient {
  constructor(private readonly cfg: VenusProviderConfig) {}

  private assertSecureUrl(): void {
    const url = new URL(this.cfg.baseUrl);
    if (url.protocol === "http:") {
      const h = url.hostname;
      const privateHost =
        h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".local") ||
        /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
      if (!privateHost && !this.cfg.allowInsecureHttp) {
        throw new ComputerUseError(
          "invalid_request",
          `Refusing plain-HTTP vision endpoint on public host ${h}`,
          { hint: "Use https:// or set VENUS_ALLOW_INSECURE_HTTP=1" },
        );
      }
    }
  }

  /**
   * Generic chat turn (official protocol shape: system + alternating
   * user/assistant history + current screenshot). Returns assistant text
   * plus the separate reasoning field when the server exposes one.
   * Retries transient failures (network/5xx/429) with linear backoff.
   */
  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    this.assertSecureUrl();
    const enableThinking = opts.enableThinking ?? this.cfg.enableThinking;
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      temperature: opts.temperature ?? this.cfg.temperature,
      top_p: opts.topP ?? 0.7,
      max_tokens: opts.maxTokens ?? 1024,
      // The W8A8 deployment thinks BY DEFAULT; non-thinking callers must
      // explicitly disable it (official usage passes this field on every
      // grounding request), so it is always sent, never omitted.
      chat_template_kwargs: { enable_thinking: enableThinking },
    };

    const retries = opts.retries ?? 2;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
      try {
        const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          const retryable = res.status === 429 || res.status >= 500;
          lastError = new ComputerUseError("provider_error", `UI-Venus HTTP ${res.status}: ${text.slice(0, 300)}`);
          if (retryable && attempt < retries) {
            await sleep(500 * (attempt + 1));
            continue;
          }
          throw lastError;
        }
        const json = (await res.json()) as {
          choices?: { message?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null } }[];
        };
        const message = json.choices?.[0]?.message;
        let content = message?.content ?? "";
        const reasoningRaw = message?.reasoning_content ?? message?.reasoning ?? "";
        const reasoning = typeof reasoningRaw === "string" ? reasoningRaw : "";
        // vLLM reasoning-parser: a thinking response can arrive with an
        // EMPTY content and everything in reasoning_content (official
        // call_model prepends reasoning when content lacks <think>).
        if (!content.trim() && reasoning.trim()) {
          content = `<think>\n${reasoning.trim()}\n</think>\n`;
        }
        if (!content.trim()) {
          throw new ComputerUseError("provider_error", "UI-Venus returned no content", { details: json as never });
        }
        return { content, reasoning };
      } catch (e) {
        lastError = e;
        const isAbort = e instanceof Error && e.name === "AbortError";
        const retryable = !(e instanceof ComputerUseError) || isAbort;
        if (retryable && attempt < retries) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        if (e instanceof ComputerUseError) throw e;
        throw new ComputerUseError("provider_error", `UI-Venus request failed: ${(e as Error).message}`, {
          cause: e,
        });
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof ComputerUseError
      ? lastError
      : new ComputerUseError("provider_error", String(lastError));
  }

  /** Convenience: single image + prompt turn (grounding / verify / inspect). */
  async chatWithImage(
    imageDataBase64: string,
    imageMimeType: "image/png" | "image/jpeg",
    prompt: string,
    opts: ChatOptions = {},
  ): Promise<string> {
    const result = await this.chat(
      [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              min_pixels: this.cfg.minPixels,
              max_pixels: this.cfg.maxPixels,
              image_url: { url: `data:${imageMimeType};base64,${imageDataBase64}` },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
      opts,
    );
    return result.content;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
