/**
 * MCP server integration: drives buildMcpServer through the official SDK
 * client over InMemoryTransport — the same path a real agent (ZCode,
 * Claude Code, Codex) would take, minus the wire.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildContext, type ComputerUseContext } from "../../src/context.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import { MockAdapter, createDefaultMockState } from "../../src/platforms/mock/adapter.js";
import { MockProvider, decideClickElement, decideFinish, mockElement } from "../../src/providers/mock/provider.js";
import type { AdapterRegistration } from "../../src/platforms/router.js";

let ctx: ComputerUseContext;
let client: Client;

async function connect(): Promise<void> {
  const server = buildMcpServer(ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
}

beforeAll(async () => {
  const adapter = new MockAdapter(createDefaultMockState());
  const reg: AdapterRegistration = {
    platform: "mock" as never,
    factory: async () => adapter,
    probe: async () => ({ available: true }),
  };
  ctx = await buildContext({
    extraAdapters: [reg],
    // registry's transient "mock" provider reads mockScript off the config
    cfg: {
      defaultProvider: "mock",
      mockScript: {
        decide: [
          decideClickElement(mockElement({ id: "mock:btn-settings", name: "设置", role: "button" })),
          decideFinish(),
        ],
        verify: [{ pass: true, source: "vision", evidence: "settings page", confidence: 0.9, raw: "" }],
      },
    } as never,
  });
  client = new Client({ name: "test-client", version: "0" });
  await connect();
}, 30_000);

describe("MCP server over SDK client", () => {
  it("lists all 17 spec tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toHaveLength(17);
    for (const required of [
      "computer_list_targets", "computer_get_target", "computer_get_state", "computer_inspect",
      "computer_screenshot", "computer_locate", "computer_action", "computer_step",
      "computer_execute_task", "computer_verify", "computer_record_start", "computer_record_stop",
      "computer_record_to_script", "computer_run_script", "computer_run_ui_test",
      "computer_get_task", "computer_cancel_task",
    ]) {
      expect(names).toContain(required);
    }
  });

  it("computer_list_targets shows the mock target", async () => {
    const res = await client.callTool({ name: "computer_list_targets", arguments: {} });
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain('"mock"');
  });

  it("computer_screenshot returns metadata + an image block", async () => {
    const res = await client.callTool({
      name: "computer_screenshot",
      arguments: { target: { type: "local", platform: "mock" } },
    });
    const blocks = res.content as { type: string; text?: string; data?: string; mimeType?: string }[];
    expect(blocks.some((b) => b.type === "image" && (b.data?.length ?? 0) > 100)).toBe(true);
    const meta = JSON.parse(blocks[0]!.text!);
    expect(meta.screenshot.width).toBe(800);
  });

  it("computer_locate finds 设置 via the structured tree", async () => {
    const res = await client.callTool({
      name: "computer_locate",
      arguments: { target: { type: "local", platform: "mock" }, instruction: "设置" },
    });
    const out = JSON.parse((res.content as { text: string }[])[0]!.text!);
    expect(out.source).toBe("structured");
    expect(out.element.name).toBe("设置");
  });

  it("computer_execute_task (wait) completes the mock flow", async () => {
    const res = await client.callTool({
      name: "computer_execute_task",
      arguments: {
        target: { type: "local", platform: "mock" },
        task: "打开设置",
        mode: "delegate",
        wait: true,
        maxSteps: 8,
      },
    });
    const record = JSON.parse((res.content as { text: string }[])[0]!.text!);
    expect(record.outcome.status).toBe("SUCCESS");
    // the click step is recorded; the final finished() routes to verify, not steps
    expect(record.steps.length).toBeGreaterThanOrEqual(1);
    expect(record.steps[0].action.type).toBe("click");
    expect(record.outcome.verify.pass).toBe(true);
  });

  it("computer_run_ui_test reports PASS for a valid DSL case", async () => {
    const res = await client.callTool({
      name: "computer_run_ui_test",
      arguments: {
        target: { type: "local", platform: "mock" },
        cases: [
          {
            name: "toggle-off",
            yaml: `name: t\ntarget: { type: local, platform: mock }\nsteps:\n  - locate: { name: 自动更新 }\n    action: toggle\n    value: false\nassert:\n  - element: { name: 自动更新 }\n    property: { checked: false }`,
          },
        ],
      },
    });
    const report = JSON.parse((res.content as { text: string }[])[0]!.text!);
    expect(report.status).toBe("PASS");
    expect(report.cases[0].status).toBe("PASS");
  });

  it("recorder flow: start → action → to_script emits semantic YAML", async () => {
    const args = { target: { type: "local", platform: "mock" } };
    await client.callTool({ name: "computer_record_start", arguments: args });
    await client.callTool({
      name: "computer_action",
      arguments: { ...args, action: { type: "click", element: { id: "mock:btn-save", source: "uia", role: "button", name: "保存" } } },
    });
    const res = await client.callTool({
      name: "computer_record_to_script",
      arguments: { ...args, name: "click-save" },
    });
    const out = JSON.parse((res.content as { text: string }[])[0]!.text!);
    expect(out.yaml).toContain("保存");
    expect(out.yaml).toContain("click");
    // recorder is consumed after to_script
    const res2 = await client.callTool({ name: "computer_record_to_script", arguments: { ...args, name: "again" } });
    expect((res2.content as { text: string }[])[0]!.text!).toContain("No active recording");
  });

  it("computer_get_task / cancel_task", async () => {
    const res = await client.callTool({ name: "computer_get_task", arguments: { taskId: "nope" } });
    expect((res.content as { text: string }[])[0]!.text!).toContain("Unknown task");
    const res2 = await client.callTool({ name: "computer_cancel_task", arguments: { taskId: "nope" } });
    expect((res2.content as { text: string }[])[0]!.text!).toContain('"ok": false');
  });
});
