# Installation

## From the GitHub Release (recommended)

```bash
mkdir -p ~/.zcode/mcp-servers/ui-venus-mcp && cd ~/.zcode/mcp-servers/ui-venus-mcp
printf '{"name":"zcode-mcp-host","private":true}' > package.json
npm install "https://github.com/q1820926174-cpu/UI-Venus-MCP/releases/latest/download/$(\
  curl -s https://api.github.com/repos/q1820926174-cpu/UI-Venus-MCP/releases/latest \
  | grep -o 'ui-venus-mcp-[^"]*\.tgz' | head -1)"
```

Or straight from the repo (a `prepare` script builds automatically):

```bash
npm install github:q1820926174-cpu/UI-Venus-MCP
```

## From source

```bash
git clone https://github.com/q1820926174-cpu/UI-Venus-MCP
cd UI-Venus-MCP && pnpm install && pnpm build   # → dist/index.js (bin-ready)
```

## ZCode

Register in `~/.zcode/cli/config.json` (merge into `mcpServers.servers`):

```json
{
  "mcpServers": {
    "servers": {
      "ui-venus-mcp": {
        "type": "stdio",
        "command": "node",
        "args": ["/ABS/PATH/TO/node_modules/ui-venus-mcp/dist/index.js"],
        "env": {
          "VENUS_BASE_URL": "http://<gpu-host>:8300/v1",
          "VENUS_API_KEY": "<your-key>",
          "VENUS_MODEL": "UI-Venus-2-9B-W8A8",
          "CUMCP_REMOTES": "[{\"name\":\"win-151\",\"platform\":\"windows\",\"kind\":\"ssh-queue\",\"sshHost\":\"goldagent-151\",\"root\":\"C:\\\\Users\\\\gold\\\\win-remote\"}]"
        },
        "enabled": true
      }
    }
  }
}
```

Restart ZCode; verify with the smoke at the bottom.

## Claude Code / Codex / any MCP client

Same stdio shape (see [examples/mcp-config.md](../examples/mcp-config.md)):
`command: node`, `args: [<dist>/index.js]`, `env: VENUS_*`. HTTP mode for
remote agents: `node <dist>/index.js --http --port 8765`.

## Remote Windows targets

One-time onboarding per host (transfers inbox bridges, installs the
hidden session-1 agent, verifies capture):

```bash
node scripts/win-remote/bootstrap-remote.mjs <ssh-alias>   # from a source checkout
```

Then list the host under `CUMCP_REMOTES` as above. Full playbook:
[remote-targets.md](../remote-targets.md).

## Post-install smoke

```bash
node - <<'EOF'
import { spawn } from "node:child_process";
const child = spawn("node", [process.argv[1]], { stdio: ["pipe", "pipe", "inherit"] });
EOF
```

Simplest: start it and call `computer_list_targets` from your client —
expect your platform plus any configured remotes with honest availability.
`pnpm smoke:venus` (source checkout) verifies the vision endpoint.
