import { describe, expect, it, vi, afterEach } from "vitest";
import { VenusClient } from "../../src/providers/ui-venus/client.js";
import { UiVenusProvider } from "../../src/providers/ui-venus/provider.js";
import type { VenusProviderConfig } from "../../src/config.js";
import type { Observation } from "../../src/core/types.js";

const cfg = (over: Partial<VenusProviderConfig> = {}): VenusProviderConfig => ({
  baseUrl: "http://36.138.102.62:8300/v1",
  apiKey: "test-key",
  model: "UI-Venus-2-9B-W8A8",
  timeoutMs: 5_000,
  temperature: 0,
  enableThinking: false,
  minPixels: 3136,
  maxPixels: 12_845_056,
  allowInsecureHttp: true,
  ...over,
});

function okResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const obs = (withShot = true): Observation => ({
  target: { id: "mock:local", platform: "mock" as never, type: "local", name: "mock" },
  screen: { displays: [], orientation: "landscape", width: 800, height: 600 },
  screenshot: withShot
    ? {
        format: "png",
        dataBase64: "aGVsbG8=",
        width: 800,
        height: 600,
        scale: 1,
        origin: { x: 0, y: 0 },
        orientation: "landscape",
        capturedAt: 0,
        targetId: "mock",
      }
    : undefined,
  capabilities: {} as never,
  capturedAt: 0,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("VenusClient", () => {
  it("sends the documented request shape (W8A8 endpoint)", async () => {
    const fetchMock = vi.fn(async () => okResponse("[500, 500]"));
    vi.stubGlobal("fetch", fetchMock);
    const client = new VenusClient(cfg());
    await client.chatWithImage("aGVsbG8=", "image/png", "find it", { maxTokens: 32 });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://36.138.102.62:8300/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("UI-Venus-2-9B-W8A8");
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(32);
    // non-thinking calls must explicitly disable thinking (server default is ON)
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    const content = body.messages[0].content;
    expect(content[0].type).toBe("image_url");
    expect(content[0].min_pixels).toBe(3136);
    expect(content[0].max_pixels).toBe(12_845_056);
    expect(content[0].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(content[1].text).toBe("find it");
  });

  it("omits the auth header when no key is set", async () => {
    const fetchMock = vi.fn(async () => okResponse("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const client = new VenusClient(cfg({ apiKey: undefined }));
    await client.chatWithImage("x", "image/png", "p");
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("retries on 500 and succeeds", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls < 2) return new Response("boom", { status: 500 });
        return okResponse("recovered");
      }),
    );
    const client = new VenusClient(cfg());
    const out = await client.chatWithImage("x", "image/png", "p", { retries: 2 });
    expect(out).toBe("recovered");
  });

  it("throws provider_error on persistent failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const client = new VenusClient(cfg());
    await expect(client.chatWithImage("x", "image/png", "p", { retries: 1 })).rejects.toThrow(/HTTP 500/);
  });
});

describe("UiVenusProvider", () => {
  it("converts normalized [0,1000] output to screenshot pixel space", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse("[677, 685]")));
    const provider = new UiVenusProvider(cfg());
    const result = await provider.locate({ instruction: "CLOSE button", observation: obs() });
    // screenshot is 800×600 → (0.677*800, 0.685*600) = (541.6, 411)
    expect(result.source).toBe("vision");
    expect(result.point!.x).toBeCloseTo(541.6, 1);
    expect(result.point!.y).toBeCloseTo(411, 1);
    expect(result.normalized).toEqual({ x: 677, y: 685 });
  });

  it("reports not_found for [-1,-1]", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse("[-1,-1]")));
    const provider = new UiVenusProvider(cfg());
    const result = await provider.locate({ instruction: "nothing", observation: obs() });
    expect(result.source).toBe("not_found");
  });

  it("OFFICIAL protocol: parses <think>/<action> Click and converts 0-999 → pixels", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse("<think>click the button</think>\n<action>Click(box=(500, 500))</action>")),
    );
    const provider = new UiVenusProvider(cfg());
    const decision = await provider.decideNextAction({ goal: "g", observation: obs(), history: [] });
    expect(decision.action.type).toBe("click");
    expect(decision.thought).toBe("click the button");
    // official /999 rule: int(500 * 800 / 999) = 400, int(500*600/999) = 300
    if (decision.action.type === "click") {
      expect(decision.action.point!.x).toBe(400);
      expect(decision.action.point!.y).toBe(300);
      expect(decision.action.point!.space).toBe("screenshot");
    }
    expect(decision.acceptedResponse).toContain("<think>");
    expect(decision.acceptedResponse).toContain("<action>Click(box=(500, 500))</action>");
  });

  it("OFFICIAL protocol: agent turns use temperature 1.0 + thinking (model card)", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse("<action>Finished()</action>"),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new UiVenusProvider(cfg());
    await provider.decideNextAction({ goal: "g", observation: obs(), history: [] });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.temperature).toBe(1.0);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
    // official system prompt with the user task
    const system = body.messages[0].content as string;
    expect(system).toContain("You are a GUI Agent");
    expect(system).toContain("g");
  });

  it("OFFICIAL protocol: grounding stays temperature 0 / no thinking", async () => {
    const fetchMock = vi.fn(async () => okResponse("[500, 500]"));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new UiVenusProvider(cfg());
    await provider.locate({ instruction: "x", observation: obs() });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.temperature).toBe(0);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("OFFICIAL protocol: multi-turn history keeps accepted responses + last 2 screenshots", async () => {
    const fetchMock = vi.fn(async () => okResponse("<action>Finished()</action>"));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new UiVenusProvider(cfg());
    const history = [
      { index: 1, action: { type: "wait", durationMs: 1 } as never, ok: true, summary: "w", acceptedResponse: "<action>Click(box=(10, 10))</action>", screenshot: { dataBase64: "aGlzdDE=", format: "png" as const } },
      { index: 2, action: { type: "wait", durationMs: 1 } as never, ok: true, summary: "w", acceptedResponse: "<action>Wait()</action>" },
      { index: 3, action: { type: "wait", durationMs: 1 } as never, ok: true, summary: "w", acceptedResponse: "<action>Type(content='hi')</action>", screenshot: { dataBase64: "aGlzdDM=", format: "png" as const } },
      { index: 4, action: { type: "wait", durationMs: 1 } as never, ok: true, summary: "no accepted response" },
    ];
    await provider.decideNextAction({ goal: "g", observation: obs(), history });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    const msgs = body.messages;
    // system + turns(with accepted) ×2 (user+assistant) + current = 1 + 3*2 + 1 = 8
    expect(msgs).toHaveLength(8);
    const assistants = msgs.filter((m: { role: string }) => m.role === "assistant");
    expect(assistants).toHaveLength(3);
    expect(assistants[0].content).toContain("Click(box=(10, 10))");
    // history images: turns 1 and 3 have screenshots, but only the LAST 2
    // turns-with-screenshots window applies → turn 1 image dropped (only 2 kept, from turns 1..3 window: imageStart = 3-2 = 1)
    const imageMsgs = msgs.filter((m: { role: string; content: unknown }) => m.role === "user" && Array.isArray(m.content));
    // imageStart = 3 turns - 2 = 1 → filtered turn 0's image is dropped, turn 2's kept → 1 history + 1 current
    expect(imageMsgs).toHaveLength(2);
    // eslint-disable-next-line no-console
    expect(imageMsgs[imageMsgs.length - 1].content[0].text).toContain("Current Screenshot");
  });

  it("OFFICIAL protocol: Swipe/Type/Hotkey/Finished map to unified actions", async () => {
    const provider = new UiVenusProvider(cfg());
    const responses = [
      "<action>Swipe(amount=-800, axis='vertical')</action>",
      "<action>Type(content='你好\n')</action>",
      "<action>Hotkey(keys=['ctrl', 'c'], repeat=3)</action>",
      "<action>CallUser(content='cannot proceed')</action>",
    ];
    const results = [];
    for (const content of responses) {
      vi.stubGlobal("fetch", vi.fn(async () => okResponse(content)));
      results.push(await provider.decideNextAction({ goal: "g", observation: obs(), history: [] }));
    }
    expect(results[0]!.action.type).toBe("scroll");
    expect(results[0]!.action).toMatchObject({ direction: "down" });
    expect(results[1]!.action).toMatchObject({ type: "type", text: "你好", submit: true });
    expect(results[2]!.action.type).toBe("hotkey");
    expect(results[2]!.sequence).toHaveLength(2); // repeat=3 → 1 + 2 extra
    expect(results[3]!.needsUser).toBe(true);
    expect(results[3]!.action).toMatchObject({ type: "fail" });
  });

  it("OFFICIAL protocol: parse failure retries once with identical messages", async () => {
    const fetchMock = vi.fn(async () => okResponse("<action>Click(box=)</action>"));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new UiVenusProvider(cfg());
    await expect(provider.decideNextAction({ goal: "g", observation: obs(), history: [] })).rejects.toThrow(/invalid action after 2 attempts/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses to construct without an API key", () => {
    expect(() => new UiVenusProvider(cfg({ apiKey: undefined }))).toThrow(/VENUS_API_KEY/);
  });

  it("locate without screenshot errors honestly", async () => {
    const provider = new UiVenusProvider(cfg());
    await expect(provider.locate({ instruction: "x", observation: obs(false) })).rejects.toThrow(/screenshot/);
  });

  it("parses verification verdicts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse('{"pass": true, "evidence": "switch shows OFF"}')),
    );
    const provider = new UiVenusProvider(cfg());
    const r = await provider.verify({ goal: "关闭自动更新", observation: obs() });
    expect(r.pass).toBe(true);
    expect(r.evidence).toContain("OFF");
    expect(r.source).toBe("vision");
  });
});
