/**
 * Application context: config, platform router, vision provider,
 * orchestrator, DSL runner and recorder registry — one instance per
 * server process, shared across transports.
 */
import { loadConfig, type ServerConfig } from "./config.js";
import { PlatformRouter, type AdapterRegistration } from "./platforms/router.js";
import { createDefaultProvider } from "./providers/registry.js";
import type { ComputerVisionProvider } from "./providers/types.js";
import { TaskOrchestrator } from "./orchestrator/executor.js";
import { DslRunner } from "./scripting/runner.js";
import { UiTestRunner } from "./testing/ui-test.js";
import { Recorder } from "./recorder/recorder.js";
import type { Target } from "./core/types.js";

export interface ComputerUseContext {
  cfg: ServerConfig;
  router: PlatformRouter;
  provider: ComputerVisionProvider;
  orchestrator: TaskOrchestrator;
  dsl: DslRunner;
  uiTest: UiTestRunner;
  /** active recorders, keyed by router session id */
  recorders: Map<string, Recorder>;
  version: string;
}

export async function buildContext(overrides?: {
  cfg?: Partial<ServerConfig>;
  extraAdapters?: AdapterRegistration[];
}): Promise<ComputerUseContext> {
  const cfg = loadConfig(overrides?.cfg);
  const router = new PlatformRouter();

  const { adapterRegistrations } = await import("./platforms/register.js");
  for (const reg of await adapterRegistrations()) {
    router.register(reg);
  }
  for (const reg of overrides?.extraAdapters ?? []) {
    router.register(reg);
  }

  const provider = createDefaultProvider(cfg);
  const orchestrator = new TaskOrchestrator(router, provider, cfg);
  const dsl = new DslRunner(router, provider, cfg);
  const uiTest = new UiTestRunner(router, provider, cfg);

  return {
    cfg,
    router,
    provider,
    orchestrator,
    dsl,
    uiTest,
    recorders: new Map<string, Recorder>(),
    version: "0.1.0",
  };
}

/** Resolve (and cache) the router session for a target + optional recorder. */
export async function resolveSession(ctx: ComputerUseContext, target: Target) {
  const session = await ctx.router.getSession(target, ctx.cfg.security);
  return session;
}
