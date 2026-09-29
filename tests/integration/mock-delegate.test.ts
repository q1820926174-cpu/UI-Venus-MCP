/**
 * Integration: full delegate pipeline on the mock adapter with the
 * scripted mock provider — semantic clicks, verification, stop conditions
 * (spec §22), and the §44 fallback scenario (structured disabled →
 * vision-only → task still succeeds).
 */
import { describe, expect, it } from "vitest";
import { MockAdapter, createDefaultMockState } from "../../src/platforms/mock/adapter.js";
import type { AdapterRegistration } from "../../src/platforms/router.js";
import { PlatformRouter } from "../../src/platforms/router.js";
import { loadConfig } from "../../src/config.js";
import { TaskOrchestrator, type ExecuteTaskOptions } from "../../src/orchestrator/executor.js";
import { MockProvider, decideClickElement, decideClickPoint, decideFinish, mockElement, mockPointAt } from "../../src/providers/mock/provider.js";
import type { Target } from "../../src/core/types.js";

const target: Target = { type: "local", platform: "mock" as never };

function build(script = {}) {
  const adapter = new MockAdapter(createDefaultMockState());
  const router = new PlatformRouter();
  const reg: AdapterRegistration = {
    platform: "mock" as never,
    factory: async () => adapter,
    probe: async () => ({ available: true }),
  };
  router.register(reg);
  const provider = new MockProvider(script);
  const cfg = loadConfig();
  // isolated per-build data dir: listTasks() now merges persisted history
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const orch = new TaskOrchestrator(router, provider, cfg, mkdtempSync(join(tmpdir(), "cumcp-test-")));
  return { adapter, router, provider, orch, cfg };
}

const baseOpts = (goal: string, over: Partial<ExecuteTaskOptions> = {}): ExecuteTaskOptions => ({
  target,
  goal,
  mode: "delegate",
  wait: true,
  maxSteps: 12,
  ...over,
});

describe("delegate task loop (spec §22)", () => {
  it("clicks the structured element and verifies → SUCCESS", async () => {
    const { adapter, orch } = build({
      decide: [
        decideClickElement(mockElement({ id: "mock:btn-settings", name: "设置", role: "button" }), "打开设置"),
        decideFinish(),
      ],
      verify: [{ pass: true, source: "vision", evidence: "settings page visible", confidence: 0.9, raw: "" }],
    });
    const record = await orch.executeTask(baseOpts("打开设置"));
    expect(record.outcome?.status).toBe("SUCCESS");
    expect(record.state).toBe("SUCCESS");
    expect(record.steps.some((s) => s.action.type === "click" && s.ok)).toBe(true);
    expect(adapter.state.eventLog).toContain("click btn-settings");
  });

  it("model-declared finish but verification fails → FAILED with evidence", async () => {
    const { orch } = build({
      decide: [decideFinish()],
      verify: [{ pass: false, source: "vision", evidence: "still on main page", confidence: 0.9, raw: "" }],
    });
    const record = await orch.executeTask(baseOpts("打开设置"));
    expect(record.outcome?.status).toBe("FAILED");
    expect(record.outcome?.reason).toContain("verification failed");
    expect(record.outcome?.evidence).toContain("main page");
  });

  it("heuristic verifier passes 关闭自动更新 without any vision verify call", async () => {
    const { provider, orch } = build({
      decide: [decideClickElement(mockElement({ id: "mock:chk-autoupdate", name: "自动更新", role: "checkbox" })), decideFinish()],
    });
    const record = await orch.executeTask(baseOpts("关闭自动更新"));
    expect(record.outcome?.status).toBe("SUCCESS");
    expect(provider.calls.verify).toBe(0); // structured assertion sufficed
  });

  it("max steps reached → FAILED honestly", async () => {
    const no = { pass: false, source: "vision" as const, evidence: "not yet", confidence: 0.5, raw: "" };
    const { orch } = build({
      decide: [
        decideClickPoint({ x: 10, y: 10 }),
        decideClickPoint({ x: 20, y: 20 }),
        decideClickPoint({ x: 30, y: 30 }),
        decideClickPoint({ x: 40, y: 40 }),
        decideClickPoint({ x: 50, y: 50 }),
      ],
      verify: [no, no, no, no, no, no, no, no],
    });
    const record = await orch.executeTask({ ...baseOpts("impossible task"), maxSteps: 3 });
    expect(record.outcome?.status).toBe("FAILED");
    expect(record.outcome?.reason).toContain("max steps");
  });

  it("security: sensitive click parks in WAITING_CONFIRMATION then resumes on confirm", async () => {
    const { orch } = build({
      decide: [decideClickElement({ ...mockElement({ id: "mock:btn-danger", name: "删除数据", role: "button" }), source: "uia" }), decideFinish()],
      verify: [{ pass: true, source: "vision", evidence: "ok", confidence: 1, raw: "" }],
    });
    // The mock adapter's default elements don't include 删除数据, so the click
    // will coordinate-fallback; what we're testing is the confirmation gate.
    const launched = await orch.executeTask({ ...baseOpts("删除数据"), wait: false });
    // poll until the loop parks on WAITING_CONFIRMATION
    const deadline = Date.now() + 10_000;
    let first = orch.getTask(launched.id)!;
    while (first.state !== "WAITING_CONFIRMATION" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      first = orch.getTask(launched.id)!;
    }
    expect(first.state).toBe("WAITING_CONFIRMATION");
    expect(first.pendingConfirmation?.token).toBeTruthy();
    expect(first.pendingConfirmation?.reason).toContain("sensitive");
    // resuming with the token lets the loop finish
    await orch.executeTask({ ...baseOpts("删除数据"), confirmToken: first.pendingConfirmation!.token, wait: true });
    const final = orch.getTask(launched.id)!;
    expect(["SUCCESS", "FAILED"]).toContain(final.state);
  });

  it("security deny blocks launch of blocked app", async () => {
    const cfg = loadConfig();
    cfg.security.blockedApps = ["forbidden"];
    const router = new PlatformRouter();
    const reg: AdapterRegistration = { platform: "mock" as never, factory: async () => new MockAdapter(), probe: async () => ({ available: true }) };
    router.register(reg);
    const orch = new TaskOrchestrator(router, new MockProvider({ decide: [{ thought: "open it", action: { type: "launch_app", app: "Forbidden App" }, isFinal: false, raw: "" }] }), cfg);
    const record = await orch.executeTask(baseOpts("启动 Forbidden App"));
    expect(record.outcome?.status).toBe("FAILED");
    expect(record.outcome?.reason).toContain("security policy");
  });
});

describe("vision fallback (spec §44)", () => {
  it("structured disabled → vision point → task still succeeds", async () => {
    const state = createDefaultMockState();
    const adapter = new MockAdapter(state);
    adapter.structuredDisabled = true; // simulate broken/absent accessibility
    const router = new PlatformRouter();
    router.register({ platform: "mock" as never, factory: async () => adapter, probe: async () => ({ available: true }) });
    const settingsEl = state.elements.find((e) => e.id === "btn-settings")!;
    const provider = new MockProvider({
      decide: [
        // model only has the screenshot; it grounds the 设置 button
        decideClickPoint(mockPointAt(settingsEl.rect), "点击设置按钮"),
        decideFinish(),
      ],
      verify: [{ pass: true, source: "vision", evidence: "settings visible", confidence: 0.8, raw: "" }],
    });
    const orch = new TaskOrchestrator(router, provider, loadConfig());
    const record = await orch.executeTask(baseOpts("打开设置"));
    expect(record.outcome?.status).toBe("SUCCESS");
    expect(adapter.state.eventLog).toContain("click btn-settings");
    const clickStep = record.steps.find((s) => s.action.type === "click");
    expect(clickStep?.result?.method).toBe("coordinate");
  });

  it("loop guard gives up after identical repeating steps", async () => {
    const adapter = new MockAdapter(createDefaultMockState());
    const router = new PlatformRouter();
    router.register({ platform: "mock" as never, factory: async () => adapter, probe: async () => ({ available: true }) });
    // model insists on clicking the same empty point forever; screen never changes
    const no = { pass: false, source: "vision" as const, evidence: "not yet", confidence: 0.5, raw: "" };
    const provider = new MockProvider({
      decide: Array.from({ length: 20 }, () => decideClickPoint({ x: 700, y: 500 }, "try here")),
      verify: Array.from({ length: 20 }, () => no),
    });
    const cfg = loadConfig();
    cfg.orchestrator.maxStagnation = 3;
    const orch = new TaskOrchestrator(router, provider, cfg);
    const record = await orch.executeTask({ ...baseOpts("click nothing"), maxSteps: 20 });
    expect(record.outcome?.status).toBe("FAILED");
    expect(record.outcome?.reason).toMatch(/stagnation|max steps/i);
  });
});

describe("task registry", () => {
  it("background execution returns taskId; get/cancel work", async () => {
    const { orch } = build({
      decide: [decideFinish()],
      verify: [{ pass: true, source: "vision", evidence: "ok", confidence: 1, raw: "" }],
    });
    const record = await orch.executeTask({ ...baseOpts("quick task"), wait: false });
    expect(record.id).toBeTruthy();
    expect(record.state).toBe("CREATED");
    // eventually completes
    const deadline = Date.now() + 5000;
    while (orch.getTask(record.id)!.state === "CREATED" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(orch.getTask(record.id)!.outcome?.status).toBe("SUCCESS");
    expect(orch.listTasks().length).toBe(1);
    expect(orch.cancelTask(record.id)).toBe(true);
    expect(orch.cancelTask("nonexistent")).toBe(false);
  });
});
