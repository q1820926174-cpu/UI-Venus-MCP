/**
 * Integration: recorder → DSL script → replay on the mock target (spec
 * §24–§26), plus DSL runner PASS/BLOCKED semantics and router session
 * isolation (spec §41).
 */
import { describe, expect, it } from "vitest";
import { MockAdapter, createDefaultMockState } from "../../src/platforms/mock/adapter.js";
import { PlatformRouter, type AdapterRegistration } from "../../src/platforms/router.js";
import { loadConfig } from "../../src/config.js";
import { Recorder } from "../../src/recorder/recorder.js";
import { recordToScript, parseDsl, serializeDsl } from "../../src/scripting/dsl.js";
import { DslRunner } from "../../src/scripting/runner.js";
import { MockProvider } from "../../src/providers/mock/provider.js";
import type { Target } from "../../src/core/types.js";

const mockTarget: Target = { type: "local", platform: "mock" as never };

function makeRouter(): { router: PlatformRouter; adapters: MockAdapter[] } {
  const router = new PlatformRouter();
  const adapters: MockAdapter[] = [];
  router.register({
    platform: "mock" as never,
    factory: async () => {
      const a = new MockAdapter(createDefaultMockState());
      adapters.push(a);
      return a;
    },
    probe: async () => ({ available: true }),
  });
  return { router, adapters };
}

describe("recorder → DSL → replay", () => {
  it("records semantic actions and produces a replayable script", async () => {
    const { router, adapters } = makeRouter();
    const cfg = loadConfig();
    const session = await router.getSession(mockTarget, cfg.security);
    const adapter = adapters[0]!;

    const recorder = new Recorder(mockTarget);
    const obs0 = await adapter.observe();
    recorder.captureBefore(obs0.screenshot);

    const clickAction = { type: "click" as const, element: { id: "mock:btn-settings", source: "uia" as const, role: "button", name: "设置" } };
    const click = await adapter.executeAction(clickAction);
    recorder.recordAction(clickAction, click, { app: "mockapp" });
    const toggleAction = { type: "toggle" as const, element: { id: "mock:chk-autoupdate", source: "uia" as const, role: "checkbox", name: "自动更新" }, value: false };
    const toggle = await adapter.executeAction(toggleAction);
    recorder.recordAction(toggleAction, toggle, { app: "mockapp" });

    expect(recorder.entries).toHaveLength(2);
    expect(adapter.state.eventLog).toContain("click btn-settings");
    expect(adapter.state.eventLog).toContain("toggle chk-autoupdate=off");

    const script = recordToScript(recorder.entries, { name: "disable-auto-update", target: { type: "local", platform: "mock" } as never });
    expect(script.steps).toHaveLength(2);
    expect(script.steps[0]!.locate!.name).toBe("设置");
    expect(script.steps[1]!.action).toBe("toggle");

    // replay the generated YAML through the DSL runner on a FRESH adapter
    await router.closeSession(session.info.id);
    const runner = new DslRunner(router, new MockProvider(), cfg);
    const result = await runner.run({ script: parseDsl(serializeDsl(script)), target: mockTarget });
    expect(result.status).toBe("PASS");
    expect(result.steps).toHaveLength(2);
    // the fresh adapter received the same semantic operations
    expect(adapters[1]!.state.eventLog).toContain("click btn-settings");
    expect(adapters[1]!.state.eventLog).toContain("toggle chk-autoupdate=off");
  });
});

describe("DSL runner semantics", () => {
  it("PASS with assertions satisfied", async () => {
    const { router } = makeRouter();
    const cfg = loadConfig();
    const runner = new DslRunner(router, new MockProvider(), cfg);
    const result = await runner.run({
      script: parseDsl(`
name: toggle-check
target: { type: local, platform: mock }
steps:
  - locate: { name: 自动更新 }
    action: toggle
    value: false
assert:
  - element: { name: 自动更新 }
    property: { checked: false }
`),
      target: mockTarget,
    });
    expect(result.status).toBe("PASS");
    expect(result.assertions[0]!.status).toBe("PASS");
  });

  it("FAIL when a locator cannot be resolved (element miss is a test failure)", async () => {
    const { router } = makeRouter();
    const cfg = loadConfig();
    const runner = new DslRunner(router, new MockProvider(), cfg);
    const result = await runner.run({
      script: parseDsl(`
name: missing-element
target: { type: local, platform: mock }
steps:
  - locate: { name: 绝对不存在的控件 }
    action: click
`),
      target: mockTarget,
    });
    expect(result.status).toBe("FAIL");
    expect(result.steps[0]!.status).toBe("FAIL");
    expect(result.steps[0]!.error).toContain("Cannot locate");
  });

  it("BLOCKED when the environment cannot serve the target (permission denied)", async () => {
    const { router, adapters } = makeRouter();
    const cfg = loadConfig();
    await router.getSession(mockTarget, cfg.security);
    // simulate an environment restriction at the observation layer
    const adapter = adapters[0]! as unknown as { structuredDisabled: boolean } & Record<string, unknown>;
    adapter.structuredDisabled = true;
    const originalObserve = adapter.observe as unknown as (...a: unknown[]) => Promise<unknown>;
    (adapter as unknown as { observe: unknown }).observe = async (...a: unknown[]) => {
      throw new (await import("../../src/core/errors.js")).ComputerUseError(
        "permission_required",
        "Accessibility permission missing",
        { hint: "grant it" },
      );
    };
    const runner = new DslRunner(router, new MockProvider(), cfg);
    const result = await runner.run({
      script: parseDsl(`
name: permission-blocked
target: { type: local, platform: mock }
steps:
  - locate: { name: 设置 }
    action: click
`),
      target: mockTarget,
    });
    void originalObserve;
    expect(result.status).toBe("BLOCKED");
    expect(result.steps[0]!.status).toBe("BLOCKED");
  });

  it("FAIL fast on action errors, remaining steps skipped", async () => {
    const { router, adapters } = makeRouter();
    const cfg = loadConfig();
    // create the session first so the factory has built the adapter
    await router.getSession(mockTarget, cfg.security);
    adapters[0]!.structuredDisabled = true; // semantic ops throw
    const runner = new DslRunner(router, new MockProvider(), cfg);
    const result = await runner.run({
      script: parseDsl(`
name: broken
target: { type: local, platform: mock }
steps:
  - locate: { name: 设置 }
    action: click
  - action: wait
    durationMs: 10
`),
      target: mockTarget,
    });
    expect(result.status).toBe("FAIL");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.error).toContain("Cannot locate");
  });
});

describe("multi-device isolation (spec §41)", () => {
  it("sessions are isolated per target id", async () => {
    const router = new PlatformRouter();
    const created: MockAdapter[] = [];
    router.register({
      platform: "mock" as never,
      factory: async () => {
        const a = new MockAdapter(createDefaultMockState());
        created.push(a);
        return a;
      },
      probe: async () => ({ available: true }),
    });
    const cfg = loadConfig();
    const s1 = await router.getSession({ type: "local", platform: "mock" as never }, cfg.security);
    const s2 = await router.getSession({ type: "device", platform: "mock" as never, deviceId: "phone-1" }, cfg.security);
    expect(s1.info.id).not.toBe(s2.info.id);
    expect(router.listSessions().length).toBe(2);

    // act on session 1 only
    await s1.adapter.executeAction({ type: "launch_app", app: "only-on-s1" });
    expect((created[0]!.state.eventLog)).toContain("launch:only-on-s1");
    expect((created[1]!.state.eventLog)).not.toContain("launch:only-on-s1");

    // closing one leaves the other intact
    expect(await router.closeSession(s1.info.id)).toBe(true);
    expect(router.listSessions().length).toBe(1);
    await router.closeAll();
    expect(router.listSessions().length).toBe(0);
  });

  it("device allowlist blocks unauthorized device ids", async () => {
    const router = new PlatformRouter();
    router.register({ platform: "mock" as never, factory: async () => new MockAdapter(), probe: async () => ({ available: true }) });
    const cfg = loadConfig();
    cfg.security.allowedDevices = ["emulator-5554"];
    await expect(
      router.getSession({ type: "device", platform: "mock" as never, deviceId: "intruder" }, cfg.security),
    ).rejects.toThrow(/not in allowedDevices/);
  });
});
