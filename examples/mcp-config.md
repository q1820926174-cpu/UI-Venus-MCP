> Guard these with policy; see docs/api.md for the full tool contract.

# ZCode configuration (`~/.zcode/mcp.json` or project `.zcode/mcp.json`)

```json
{
  "mcpServers": {
    "ui-venus-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/ui-venus-mcp/dist/index.js"],
      "env": {
        "VENUS_BASE_URL": "http://36.138.102.62:8300/v1",
        "VENUS_API_KEY": "<your-key>",
        "VENUS_MODEL": "UI-Venus-2-9B-W8A8"
      }
    }
  }
}
```

# Claude Code / Codex (stdio, same shape)

```json
{
  "mcpServers": {
    "ui-venus-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/ui-venus-mcp/dist/index.js"]
    }
  }
}
```

# Streamable HTTP (remote agents / LAN)

```bash
node dist/index.js --http --port 8765
```

```json
{
  "mcpServers": {
    "ui-venus-mcp-remote": {
      "url": "http://<mcp-host>:8765/mcp"
    }
  }
}
```

# Typical agent loop (assist mode)

```text
1. computer_list_targets          → what can I control?
2. computer_get_target {target}   → capabilities & permissions
3. computer_inspect {target}      → screenshot + UI tree (+ vision description)
4. computer_locate  {target, instruction: "关闭按钮"}
5. computer_action  {target, action: { type: "click", element: {...} }}
6. computer_verify  {target, goal: "设置已关闭"}
```

# Full delegation (text-only agents)

```json
{
  "tool": "computer_execute_task",
  "arguments": {
    "target": { "type": "device", "platform": "android", "deviceId": "emulator-5554" },
    "task": "打开设置，将Wi-Fi打开",
    "mode": "delegate",
    "maxSteps": 30
  }
}
```
