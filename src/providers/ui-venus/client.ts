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

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | {
            type: "image_url";
            min_pixels?: number;
            max_pixels?: number;
            image_url: { url: string };
          }
      >;
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  /** extra raw messages (few-shot) appended before the user turn */
  messages?: ChatMessage[];
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
   * One vision chat turn. Returns the assistant text content.
   * Retries transient failures (network/5xx/429) with linear backoff.
   */
  async chatWithImage(
    imageDataBase64: string,
    imageMimeType: "image/png" | "image/jpeg",
    prompt: string,
    opts: ChatOptions = {},
  ): Promise<string> {
    this.assertSecureUrl();
    const body = {
      model: this.cfg.model,
      temperature: opts.temperature ?? this.cfg.temperature,
      max_tokens: opts.maxTokens ?? 1024,
      chat_template_kwargs: { enable_thinking: this.cfg.enableThinking },
      messages: [
        ...(opts.messages ?? []),
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
          choices?: { message?: { content?: string | null } }[];
        };
        const content = json.choices?.[0]?.message?.content;
        if (typeof content !== "string") {
          throw new ComputerUseError("provider_error", "UI-Venus returned no content", { details: json as never });
        }
        return content;
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
