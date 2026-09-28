# UI-Venus Serving Reference (UI-Venus-2-9B-W8A8)

The MCP does not run the vision model locally. It talks to any
OpenAI-compatible endpoint serving UI-Venus. This directory documents the
reference deployment we verified against (quantized W8A8 build on a GPU
box, vLLM-compatible runtime, systemd-managed).

## Endpoint contract (verified)

```
POST {VENUS_BASE_URL}/chat/completions
Authorization: Bearer <VENUS_API_KEY>
Content-Type: application/json

{
  "model": "UI-Venus-2-9B-W8A8",
  "temperature": 0,
  "max_tokens": 1024,
  "chat_template_kwargs": { "enable_thinking": false },
  "messages": [{
    "role": "user",
    "content": [
      { "type": "image_url", "min_pixels": 3136, "max_pixels": 12845056,
        "image_url": { "url": "data:image/png;base64,..." } },
      { "type": "text", "text": "<grounding or agent prompt>" }
    ]
  }]
}
```

**Two task families, two protocols** (per the official model card +
`inclusionAI/UI-Venus` @ UI-Venus-2, `models/computer/computer_example.py`,
aligned 2026-09-28):

### GUI grounding (locate)

- Single-shot, **thinking OFF, temperature 0**; `chat_template_kwargs.enable_thinking`
  must be sent explicitly false — the deployment thinks by default.
- Output `[x, y]` normalized to **[0, 1000]**; `[-1,-1]` = infeasible.
- Official prompt:

```text
Output the center point of the position corresponding to the following instruction:
{instruction}.

The output should just be the coordinates of a point, in the format [x,y].
Additionally, if the task is infeasible (e.g., the task is not related to the image),
the output should be [-1,-1].
```

Live calibration: button at pixel (1300,740) on 1920×1080 → `[676, 684]`
(`tests/e2e/venus-live.test.ts` + `tests/fixtures/calibration.png`).

### Agentic loop (decideNextAction)

- **Official system prompt** (verbatim, from `computer_example.py`) with the
  user task and a sudo-password slot (`VENUS_SUDO_PASSWORD`).
- Output format: `<think> ... </think>` + `<action> the next action </action>`;
  vLLM `reasoning_content` is merged when content has no `<think>` tag.
- Action grammar (Python-call syntax, keyword args only):
  `Click(box=(x, y))` · `DoubleClick/TripleClick/RightClick/MiddleClick` ·
  `Hover` · `Drag(end=, start=)` · `Swipe(amount=, axis=)` · `Type(content=)`
  · `Hotkey(keys=, repeat=)` · `KeyDown/KeyUp/MouseDown/MouseUp` ·
  `Sequence(actions=[...])` (2–32, no nesting, terminal last) · `Wait()` ·
  `CallUser(content=)` · `Finished(content=)`.
- **Coordinates are [0, 999]**, converted with `int(v × size / 999)`
  clamped to `[0, size-1]` (NOT /1000 — corrected after reading the
  official implementation).
- Model card: agentic tasks use **temperature 1.0 + reasoning enabled +
  full reasoning history** (configurable: `VENUS_AGENT_TEMPERATURE`,
  `VENUS_AGENT_ENABLE_THINKING`; defaults follow the model card).
- Multi-turn context: **accepted-only** assistant history (rejected
  responses never enter the conversation) + the last N history screenshots
  (`VENUS_AGENT_HISTORY_IMAGES`, default 2). One same-messages retry on
  parse failure (official default 1).
- The provider parser is AST-safe (no eval): rejects positional args,
  `**kwargs`, nested Sequence, non-literal values, unknown actions.

## Configuration

```bash
VENUS_BASE_URL=http://<gpu-host>:8300/v1   # OpenAI-compatible base (no /chat/completions)
VENUS_API_KEY=<key>                        # bearer token
VENUS_MODEL=UI-Venus-2-9B-W8A8
VENUS_TIMEOUT_MS=120000
VENUS_MIN_PIXELS=3136
VENUS_MAX_PIXELS=12845056
```

Key reachability: `pnpm smoke:venus` sends one calibration request and
prints the parsed coordinates.

## Remote deployment architecture (spec §40)

The client machine never needs GPU memory for the 9B model:

```text
User machine (Windows/Linux/macOS/Android host)
    │  Computer-Use MCP (stdio or Streamable HTTP)
    │  screenshot (base64, downscaled for vision)
    ▼
GPU server — UI-Venus-2-9B-W8A8 (vLLM-compatible, HTTP)
    │  [x,y] normalized / action JSON
    ▼
User machine executes the action natively (UIA / AX / AT-SPI /
UIAutomator / XCUITest / Playwright)
```

## Reference service management (example)

Our reference deployment runs as a systemd service on the GPU box:

```ini
# /etc/systemd/system/venus-w8a8-8300.service  (example shape)
[Unit]
Description=UI-Venus-2-9B-W8A8 (vLLM-compatible, port 8300)
After=network.target

[Service]
ExecStart=/opt/venus-quant/start.sh
WorkingDirectory=/opt/venus-quant
Restart=on-failure
User=venus

[Install]
WantedBy=multi-user.target
```

Logs: `/opt/venus-quant/logs/venus_w8a8_8300.log`
Health: `curl -s http://<gpu-host>:8300/v1/models`

> Adjust paths/model names to your deployment. The MCP only requires the
> OpenAI-compatible HTTP contract above.

## Quantization notes (W8A8)

- Accuracy parity with BF16: 0.00pp on the internal validation set;
  +0.25pp on VenusBench-GD (official numbers for this build).
- ~36.7% less VRAM, 8–14% lower per-step latency versus BF16.
- Serve with `enable_thinking: false` support (chat_template_kwargs) so
  grounding stays a single fast turn.

## Swapping providers

UI-Venus is a pluggable provider (spec §19). To add UI-TARS / Qwen-GUI /
any VLM, implement `ComputerVisionProvider`
(`src/providers/types.ts`) — `locate / decideNextAction / verify /
inspect` — and register it in `src/providers/registry.ts`. Nothing else
in the system is allowed to know which vision model is in use.
