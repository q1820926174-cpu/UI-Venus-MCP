/**
 * Entry point (spec §39):
 *   stdio (default)          — ZCode / Claude Code / Codex local use
 *   --http --port N          — Streamable HTTP for remote GPU / LAN agents
 *
 * Env: VENUS_BASE_URL / VENUS_API_KEY / VENUS_MODEL / CUMCP_* (see .env.example)
 */
import { buildContext } from "./context.js";
import { buildMcpServer } from "./mcp/server.js";

interface CliArgs {
  http: boolean;
  port: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { http: false, port: 8765 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--http") args.http = true;
    else if (a === "--port" || a === "-p") args.port = Number(argv[++i] ?? 8765);
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`ui-venus-mcp — Cross-Platform Computer-Use MCP server

Usage:
  ui-venus-mcp [options]

Options:
  (default)        stdio transport — for ZCode / Claude Code / Codex
  --http           Streamable HTTP transport (remote agents, LAN devices)
  --port <n>       HTTP port (default 8765)
  -h, --help       show help

Env:
  VENUS_BASE_URL   UI-Venus OpenAI-compatible endpoint (default http://36.138.102.62:8300/v1)
  VENUS_API_KEY    bearer key (required for vision features)
  VENUS_MODEL      model name (default UI-Venus-2-9B-W8A8)
  CUMCP_*          server behavior, see .env.example / docs
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ctx = await buildContext();

  if (!args.http) {
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const server = buildMcpServer(ctx);
    await server.connect(new StdioServerTransport());
    // stdout is the MCP channel — log to stderr only
    console.error(`ui-venus-mcp ${ctx.version} ready (stdio); providers: ${ctx.provider.name}`);
    return;
  }

  const { createServer } = await import("node:http");
  const { randomUUID } = await import("node:crypto");
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");

  const httpServer = createServer(async (req, res) => {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, mcp-session-id, authorization",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const url = req.url ?? "/";
    if (url !== "/mcp") {
      res.writeHead(404, cors);
      res.end(JSON.stringify({ error: "use /mcp" }));
      return;
    }
    // Stateless mode: a fresh transport per request; the shared context
    // keeps device sessions alive across requests.
    const server = buildMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    await transport.handleRequest(req, res, JSON.parse(body.toString("utf8") || "{}"));
  });

  httpServer.listen(args.port, () => {
    console.log(`ui-venus-mcp ${ctx.version} listening on http://0.0.0.0:${args.port}/mcp (stateless, provider: ${ctx.provider.name}) [req ${randomUUID().slice(0, 4)}]`);
  });
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
