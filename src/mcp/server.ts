/**
 * MCP tool layer (spec §16) — every tool the spec requires, in one place.
 * Tools are thin: they resolve the target, delegate to the context, and
 * serialize honest results (including blocked/permission evidence).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ComputerUseContext } from "../context.js";
import type { Target } from "../core/types.js";
import { ComputerUseError } from "../core/errors.js";
import { actionSchema, parseAction } from "../core/actions.js";
import { parseDsl } from "../scripting/dsl.js";
import { readFileSync } from "node:fs";

const targetSchema = z
  .object({
    type: z.enum(["local", "device", "simulator", "browser", "remote", "vm"]).default("local"),
    platform: z.string().default("auto"),
    deviceId: z.string().optional(),
    browser: z.string().optional(),
    url: z.string().optional(),
    cdpEndpoint: z.string().optional(),
    host: z.string().optional(),
  })
  .optional()
  .describe("Unified device target (spec §14). Defaults to this machine with auto-detected platform.");

type ToolExtra = { sessionId?: string };

/** Coerce tool input (platform is a string from JSON) into the Target type. */
function toTarget(input: z.infer<typeof targetSchema> | undefined): Target {
  const t = input ?? { type: "local", platform: "auto" };
  return {
    type: t.type,
    platform: t.platform as Target["platform"],
    deviceId: t.deviceId,
    browser: t.browser,
    url: t.url,
    cdpEndpoint: t.cdpEndpoint,
    host: t.host,
  };
}

function errToJson(e: unknown): Record<string, unknown> {
  if (e instanceof ComputerUseError) return { error: e.toJSON() };
  return { error: { code: "internal_error", message: (e as Error).message } };
}

function json(v: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] };
}

function jsonWithImage(v: unknown, image: { dataBase64: string; mimeType: string }) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(v, null, 2) },
      { type: "image" as const, data: image.dataBase64, mimeType: image.mimeType },
    ],
  };
}

export function buildMcpServer(ctx: ComputerUseContext): McpServer {
  const server = new McpServer(
    { name: "ui-venus-mcp", version: ctx.version },
    { instructions: "Cross-Platform Computer-Use MCP: structured-first GUI automation with vision fallback (UI-Venus). Start with computer_list_targets." },
  );

  async function resolveSession(target: z.infer<typeof targetSchema> | undefined) {
    return ctx.router.getSession(toTarget(target), ctx.cfg.security);
  }

  /** ---------------------------------------------------------------- targets */

  server.registerTool(
    "computer_list_targets",
    {
      title: "List computer targets",
      description: "Enumerate every device/platform this MCP server can currently serve (local desktops, android devices, ios simulators, browser), with availability and honest capability notes.",
      inputSchema: {},
    },
    async () => {
      try {
        return json({ targets: await ctx.router.listTargets() });
      } catch (e) {
        return json(errToJson(e));
      }
    },
  );

  server.registerTool(
    "computer_get_target",
    {
      title: "Get target details",
      description: "Resolve one target and report its capabilities, permission state and platform details.",
      inputSchema: { target: targetSchema },
    },
    async ({ target }) => {
      try {
        const session = await resolveSession(target);
        return json({
          target: session.info,
          capabilities: session.adapter.getCapabilities(),
          sessions: ctx.router.listSessions().map((s) => s.info.id),
        });
      } catch (e) {
        return json(errToJson(e));
      }
    },
  );

  /** ---------------------------------------------------------------- observe */

  server.registerTool(
    "computer_get_state",
    {
      title: "Get computer state",
      description: "Cheap structural state: screen info, frontmost app, windows, capabilities. No screenshot.",
      inputSchema: { target: targetSchema },
    },
    async ({ target }) => {
      try {
        const session = await resolveSession(target);
        const obs = await session.adapter.observe({ includeScreenshot: false, includeUITree: true });
        return json(obs);
      } catch (e) {
        return json(errToJson(e));
      }
    },
  );

  server.registerTool(
    "computer_inspect",
    {
      title: "Inspect screen (vision)",
      description: "Full observation: screenshot + UI tree, optionally with a vision-model description focused on a topic.",
      inputSchema: {
        target: targetSchema,
        focus: z.string().optional().describe("Optional focus instruction for the vision model"),
        includeTree: z.boolean().default(true),
        maxTreeDepth: z.number().int().min(1).max(30).optional(),
      },
    },
    async ({ target, focus, includeTree, maxTreeDepth }) => {
      try {
        const session = await resolveSession(target);
        const obs = await session.adapter.observe({ includeUITree: includeTree, maxTreeDepth });
        let inspection;
        if (obs.screenshot) {
          inspection = await ctx.provider.inspect({ observation: obs, focus }).catch((e: Error) => ({ description: `vision inspect failed: ${e.message}`, raw: "" }));
        }
        const { screenshot: _s, ...rest } = obs;
        return jsonWithImage(
          { observation: rest, inspection, screenshotMeta: obs.screenshot ? { width: obs.screenshot.width, height: obs.screenshot.height, scale: obs.screenshot.scale, hash: obs.screenshot.hash } : null },
          obs.screenshot ? { dataBase64: obs.screenshot.dataBase64, mimeType: obs.screenshot.format === "jpeg" ? "image/jpeg" : "image/png" } : { dataBase64: "", mimeType: "image/png" },
        );
      } catch (e) {
        return json(errToJson(e));
      }
    },
  );

  server.registerTool(
    "computer_screenshot",
    {
      title: "Take screenshot",
      description: "Capture the screen/window/display. Returns metadata + image content; optionally saves to a file.",
      inputSchema: {
        target: targetSchema,
        windowId: z.string().optional(),
        displayId: z.string().optional(),
        region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
        savePath: z.string().optional(),
      },
    },
    async ({ target, windowId, displayId, region, savePath }) => {
      try {
        const session = await resolveSession(target);
        const shot = await session.adapter.screenshot({ windowId, displayId, region });
        if (savePath) {
          const { writeFileSync } = await import("node:fs");
          writeFileSync(savePath, Buffer.from(shot.dataBase64, "base64"));
        }
        const { dataBase64: _d, ...meta } = shot;
        return jsonWithImage({ screenshot: { ...meta, savedTo: savePath } }, { dataBase64: shot.dataBase64, mimeType: shot.format === "jpeg" ? "image/jpeg" : "image/png" });
      } catch (e) {
        return json(errToJson(e));
      }
    },
  );

  /** ---------------------------------------------------------------- locate & act */

  server.registerTool(
    "computer_locate",
    {
      title: "Locate element (fusion)",
      description: "Find an element by natural language or structured descriptor. Structured (UIA/AX/AT-SPI/DOM) first, UI-Venus vision grounding as fallback; vision points are snapped back to structured elements when possible. Coordinates in results are screenshot pixel space; use with computer_action.",
      inputSchema: {
        target: targetSchema,
        instruction: z.string().describe('Natural language element description, e.g. "关闭按钮" or "the login button"'),
        descriptor: z
          .object({
            role: z.string().optional(),
            name: z.string().optional(),
            text: z.string().optional(),
            resourceId: z.string().optional(),
            css: z.string().optional(),
            xpath: z.string().optional(),
            testId: z.string().optional(),
            index: z.number().int().optional(),
          })
          .optional(),
        preferStructured: z.boolean().default(true),
      },
    },
    async ({ target, instruction, descriptor, preferStructured }) => {
      try {
        const session = await resolveSession(target);
        const obs = await session.adapter.observe({ includeScreenshot: true, includeUITree: true });
        const { FusionLocator } = await import("../orchestrator/locator.js");
        const locator = new FusionLocator(ctx.provider);
        const result = await locator.locate(session.adapter, { instruction, descriptor, observation: obs, preferStructured });
        return json(result);
      } catch (e) {
        return json(errToJson(e));
      }
    },
  );

  server.registerTool(
    "computer_action",
    {
      title: "Execute one action",
      description: "Execute a single unified action (spec §17): click/double_click/right_click/long_press/move/drag/swipe/scroll/type/set_value/clear/press/hotkey/select/toggle/invoke/launch_app/terminate_app/focus/back/home/wait. Provide element (from computer_locate) or point. Records to the active recorder if recording.",
      inputSchema: {
        target: targetSchema,
        action: actionSchema.describe("Unified action"),
        confirmToken: z.string().optional().describe("Confirmation token from a WAITING_CONFIRMATION result"),
      },
    },
    async ({ target, action: rawAction, confirmToken }) => {
      try {
        const session = await resolveSession(target);
        const action = parseAction(rawAction);
        // security gate
        const { evaluateAction } = await import("../orchestrator/security.js");
        const verdict = evaluateAction(action, ctx.cfg.security);
        if (verdict.verdict === "deny") {
          return json({ ok: false, error: { code: "security_blocked", message: verdict.reason } });
        }
        if (verdict.verdict === "confirm" && ctx.cfg.security.confirmSensitiveActions && !confirmToken) {
          const token = ctx.orchestrator.confirmations.park(action, verdict.reason, ctx.cfg.security.confirmationTimeoutMs);
          return json({
            ok: false,
            state: "WAITING_CONFIRMATION",
            confirmToken: token,
            reason: verdict.reason,
            hint: "Re-call computer_action with the same action plus confirmToken to execute.",
          });
        }
        const recorder = ctx.recorders.get(session.info.id);
        if (recorder) {
          const obs = await session.adapter.observe({ includeScreenshot: true, includeUITree: false });
          recorder.captureBefore(obs.screenshot);
        }
        const result = await session.adapter.executeAction(action);
        if (recorder) {
          const obs = await session.adapter.observe({ includeScreenshot: true, includeUITree: false });
          recorder.recordAction(action, result, { afterShot: obs.screenshot, app: obs.activeApp?.name });
        }
        return json(result);
      } catch (e) {
        return json(errToJson(e));
      }
    },
  );

  /** ---------------------------------------------------------------- step & task */

  server.registerTool(
    "computer_step",
    {
      title: "One autonomous step",
      description: "Observe + let the vision GUI expert decide the next action + execute it. Returns the decision and execution result. Useful for building your own loop in the calling agent.",
      inputSchema: {
        target: targetSchema,
        goal: z.string(),
        language: z.enum(["en", "zh"]).optional(),
        dryRun: z.boolean().default(false).describe("Decide but do not execute"),
      },
    },
    async ({ target, goal, language, dryRun }) => {
      try {
        const session = await resolveSession(target);
        const obs = await session.adapter.observe({ includeScreenshot: true, includeUITree: true });
        const decision = await ctx.provider.decideNextAction({ goal, observation: obs, history: [], language });
        const action = parseAction(decision.action);
        let result;
        if (!dryRun && action.type !== "finish" && action.type !== "fail") {
          result = await session.adapter.executeAction(action);
        }
        return json({ thought: decision.thought, action, isFinal: decision.isFinal, result, screenshotHash: obs.screenshot?.hash });
      } catch (e) {
        return json(errToJson(e));
      }
    },
  );

  server.registerTool(
    "computer_execute_task",
    {
      title: "Execute a full GUI task",
      description: "Delegate a natural-language task to the autonomous GUI agent loop (observe → decide → locate → execute → verify → recover). mode=delegate|auto. Returns immediately with a taskId unless wait=true. Sensitive actions park in WAITING_CONFIRMATION with a confirmToken — re-call with the token to approve.",
      inputSchema: {
        target: targetSchema,
        task: z.string().describe("Natural language task, e.g. 打开设置，将Wi-Fi打开"),
        mode: z.enum(["delegate", "assist", "direct", "auto"]).default("auto"),
        maxSteps: z.number().int().min(1).max(100).optional(),
        language: z.enum(["en", "zh"]).optional(),
        wait: z.boolean().default(false).describe("Wait for completion instead of returning a taskId"),
        confirmToken: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const record = await ctx.orchestrator.executeTask({
          target: toTarget(args.target),
          goal: args.task,
          mode: args.mode,
          maxSteps: args.maxSteps,
          language: args.language,
          wait: args.wait,
          confirmToken: args.confirmToken,
        });
        return json(record);
      } catch (e) {
        return json(errToJson(e));
      }
    },
  );

  server.registerTool(
    "computer_get_task",
    {
      title: "Get task status",
      description: "Fetch a task record: state, steps, outcome, pending confirmation.",
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => {
      const record = ctx.orchestrator.getTask(taskId);
      if (!record) return json(errToJson(new ComputerUseError("invalid_request", `Unknown task ${taskId}`)));
      return json(record);
    },
  );

  server.registerTool(
    "computer_cancel_task",
    {
      title: "Cancel task",
      description: "Request cancellation of a running task; also cancels its pending confirmation.",
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => {
      const ok = ctx.orchestrator.cancelTask(taskId);
      return json({ ok });
    },
  );

  /** ---------------------------------------------------------------- verify */

  server.registerTool(
    "computer_verify",
    {
      title: "Verify state",
      description: "Verify a goal against the current screen: structured UI-tree heuristics first, UI-Venus vision verification as fallback. Supports structured assertions (checked/exists/value/textVisible).",
      inputSchema: {
        target: targetSchema,
        goal: z.string().optional(),
        assertion: z
          .object({
            element: z.object({ name: z.string().optional(), role: z.string().optional(), resourceId: z.string().optional() }).optional(),
            property: z.object({
              checked: z.boolean().optional(),
              exists: z.boolean().optional(),
              valueEquals: z.string().optional(),
              valueContains: z.string().optional(),
              textVisible: z.string().optional(),
            }),
          })
          .optional(),
      },
    },
    async ({ target, goal, assertion }) => {
      try {
        if (!goal && !assertion) {
          throw new ComputerUseError("invalid_request", "Provide `goal` or `assertion`");
        }
        const session = await resolveSession(target);
        const obs = await session.adapter.observe({ includeScreenshot: true, includeUITree: true });
        const { Verifier } = await import("../orchestrator/verifier.js");
        const verifier = new Verifier(ctx.provider);
        if (assertion) {
          const outcome = await verifier.verifyAssertion(obs, { element: assertion.element, property: assertion.property });
          return json(outcome);
        }
        return json(await verifier.verifyGoal(obs, goal!));
      } catch (e) {
        return json(errToJson(e));
      }
    },
  );

  /** ---------------------------------------------------------------- recorder */

  server.registerTool(
    "computer_record_start",
    {
      title: "Start recording",
      description: "Start recording executed actions on a target session (semantic evidence: elements, hashes, apps).",
      inputSchema: { target: targetSchema },
    },
    async ({ target }) => {
      try {
        const session = await resolveSession(target);
        const { Recorder } = await import("../recorder/recorder.js");
        ctx.recorders.set(session.info.id, new Recorder(session.target));
        return json({ ok: true, recording: session.info.id });
      } catch (e) {
        return json(errToJson(e));
      }
    },
  );

  server.registerTool(
    "computer_record_stop",
    {
      title: "Stop recording",
      description: "Stop recording and return the recorded entries.",
      inputSchema: { target: targetSchema },
    },
    async ({ target }) => {
      try {
        const session = await resolveSession(target);
        const recorder = ctx.recorders.get(session.info.id);
        if (!recorder) return json(errToJson(new ComputerUseError("invalid_request", "No active recording for this target")));
        const data = recorder.toJSON();
        ctx.recorders.delete(session.info.id);
        return json(data);
      } catch (e) {
        return json(errToJson(e));
      }
    },
  );

  server.registerTool(
    "computer_record_to_script",
    {
      title: "Recording → automation script",
      description: "Convert the current/last recording into a portable YAML automation script with semantic locators (never raw coordinates).",
      inputSchema: {
        target: targetSchema,
        name: z.string().default("recorded-flow"),
        stop: z.boolean().default(true),
      },
    },
    async ({ target, name, stop }) => {
      try {
        const session = await resolveSession(target);
        const recorder = ctx.recorders.get(session.info.id);
        if (!recorder) return json(errToJson(new ComputerUseError("invalid_request", "No active recording for this target")));
        const { recordToScript, serializeDsl } = await import("../scripting/dsl.js");
        const script = recordToScript(recorder.entries, {
          name,
          target: { type: session.target.type, platform: session.target.platform, deviceId: session.target.deviceId, app: recorder.entries[0]?.app },
        });
        const yamlText = serializeDsl(script);
        if (stop) ctx.recorders.delete(session.info.id);
        return json({ script, yaml: yamlText });
      } catch (e) {
        return json(errToJson(e));
      }
    },
  );

  /** ---------------------------------------------------------------- scripting */

  server.registerTool(
    "computer_run_script",
    {
      title: "Run automation script",
      description: "Execute a portable YAML automation DSL script (semantic locators, cross-platform) against a target.",
      inputSchema: {
        target: targetSchema,
        yaml: z.string().optional().describe("Inline YAML script"),
        path: z.string().optional().describe("Path to a .yaml script file"),
      },
    },
    async ({ target, yaml, path }) => {
      try {
        let yamlText = yaml;
        if (!yamlText && path) yamlText = readFileSync(path, "utf8");
        if (!yamlText) throw new ComputerUseError("invalid_request", "Provide `yaml` or `path`");
        const script = parseDsl(yamlText);
        const result = await ctx.dsl.run({ script, target: toTarget(target) });
        return json(result);
      } catch (e) {
        return json(errToJson(e));
      }
    },
  );

  server.registerTool(
    "computer_run_ui_test",
    {
      title: "Run UI test suite",
      description: "Run one or more YAML UI test cases; returns PASS/FAIL/SKIP/BLOCKED per case with step evidence. BLOCKED = environmental restriction (permissions/offline/unsupported), reported honestly.",
      inputSchema: {
        target: targetSchema,
        cases: z.array(z.object({ name: z.string(), yaml: z.string() })).min(1),
      },
    },
    async ({ target, cases }) => {
      try {
        const report = await ctx.uiTest.runCases("mcp-suite", cases.map((c) => ({ name: c.name, yaml: c.yaml, target: toTarget(target) })));
        return json(report);
      } catch (e) {
        return json(errToJson(e));
      }
    },
  );

  return server;
}
