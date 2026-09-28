/**
 * UI test runtime (spec §27): runs DSL-based UI tests and reports
 * PASS / FAIL / SKIP / BLOCKED per case. BLOCKED is used honestly for
 * environmental restrictions (permissions, offline devices, missing
 * platform prerequisites) — never disguised as test failures.
 */
import type { ComputerVisionProvider } from "../providers/types.js";
import type { PlatformRouter } from "../platforms/router.js";
import type { ServerConfig } from "../config.js";
import type { Target } from "../core/types.js";
import { DslRunner, type DslRunResult } from "../scripting/runner.js";

export interface UiTestCase {
  name: string;
  /** DSL file path or inline YAML */
  yaml: string;
  target?: Target;
}

export interface UiTestReport {
  suite: string;
  status: "PASS" | "FAIL" | "SKIP" | "BLOCKED";
  cases: {
    name: string;
    status: "PASS" | "FAIL" | "SKIP" | "BLOCKED";
    reason?: string;
    detail?: DslRunResult;
  }[];
  startedAt: number;
  finishedAt: number;
  /** execution reality — one of: real-device | emulator | mock | static | unverified */
  execution: "real-device" | "emulator" | "mock" | "static" | "unverified";
}

export class UiTestRunner {
  private runner: DslRunner;

  constructor(
    private readonly router: PlatformRouter,
    provider: ComputerVisionProvider,
    private readonly cfg: ServerConfig,
  ) {
    this.runner = new DslRunner(router, provider, cfg);
  }

  async runCases(suite: string, cases: UiTestCase[], execution: UiTestReport["execution"] = "real-device"): Promise<UiTestReport> {
    const startedAt = Date.now();
    const out: UiTestReport["cases"] = [];
    for (const c of cases) {
      const target = c.target ?? ({ type: "local", platform: "auto" } as Target);
      // honest BLOCKED when the target isn't servable at all
      const summary = await this.router.getTargetSummary(target);
      if (!summary.available && !this.router.listSessions().some((s) => s.info.platform === summary.platform)) {
        out.push({
          name: c.name,
          status: "BLOCKED",
          reason: `target unavailable: ${summary.reason ?? summary.platform}`,
        });
        continue;
      }
      const { parseDsl } = await import("../scripting/dsl.js");
      try {
        const script = parseDsl(c.yaml);
        const result = await this.runner.run({ script, target });
        out.push({
          name: c.name,
          status: result.status,
          reason: result.error,
          detail: result,
        });
      } catch (e) {
        out.push({ name: c.name, status: "FAIL", reason: (e as Error).message });
      }
    }
    const status: UiTestReport["status"] = out.every((c) => c.status === "PASS")
      ? "PASS"
      : out.some((c) => c.status === "BLOCKED") && out.every((c) => c.status === "PASS" || c.status === "BLOCKED")
        ? "BLOCKED"
        : out.some((c) => c.status === "FAIL")
          ? "FAIL"
          : "SKIP";
    return { suite, status, cases: out, startedAt, finishedAt: Date.now(), execution };
  }
}
