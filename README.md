# UI-Venus MCP

**A cross-platform Computer-Use MCP server for AI agents** — unified GUI automation across Windows, Linux, macOS, Android, iOS and browsers. Structured APIs first (UIA / AX / AT-SPI / UIAutomator / XCUITest / DOM), vision grounding as the fallback, with [UI-Venus-2-9B](https://github.com/rocktreehold/UI-Venus) (W8A8 quantized build verified) as the default — and pluggable — vision provider.

> **中文文档**：[docs/README.zh-CN.md](docs/README.zh-CN.md)

```text
                    ZCode / Claude Code / Codex / OpenAI Agents / your agent
                                        │
                              ┌─────────┴─────────┐
                              │   Text or VLM     │   (any model, any size)
                              └─────────┬─────────┘
                                        │ MCP (stdio / Streamable HTTP)
                                        ▼
                     ┌──────────────────────────────────────┐
                     │      Computer-Use MCP Server         │
                     │  Orchestrator · Fusion Locator ·     │
                     │  Verifier · Recorder · DSL · Guard   │
                     └──────────────────┬───────────────────┘
                                        │
                              Platform Router (per-device sessions)
        ┌──────────┬──────────┬────────┴───┬────────────┬───────────┐
        ▼          ▼          ▼            ▼            ▼           ▼
     Windows     Linux      macOS      Android        iOS       Browser
   UIA+SendInput AT-SPI+    AX+     UIAutomator  XCUITest/   Playwright/
   PowerShell   xdotool   SystemEvents   +adb      WDA+simctl     CDP
        └──────────┴──────────┴────────────┴────────────┴───────────┘
                                        │  vision fallback (spec §4)
                                        ▼
                        UI-Venus-2-9B (remote GPU, OpenAI-compatible)
```

**The product definition:** give *any* AI agent — text-only or multimodal, small or large — unified, cross-platform, structure-first, vision-fallback computer-use capabilities. Not "an AI mouse for Windows", and not "UI-Venus wrapped in a few click APIs": UI-Venus acts as the cross-platform **GUI expert** (visual grounding, next-action decision, visual verification), while platform adapters execute reliably through native semantics whenever they exist.

## Highlights

- **17 MCP tools** — targets, state, inspect, screenshot, locate, action, step, execute_task, verify, recorder (start/stop/to_script), run_script, run_ui_test, get/cancel_task. Full contract in [docs/api.md](docs/api.md).
- **Four agent modes** (spec-level): `delegate` (autonomous loop for text-only agents), `assist` / `direct` (your agent stays in control; MCP provides primitives), `auto` (structured-first with per-step vision fallback).
- **Structure-first execution**: `click(elementRef)` becomes UIA Invoke on Windows, AXPress on macOS, AT-SPI doAction on Linux, UIAutomator tap on Android, XCUITest tap on iOS, Playwright click in browsers. Raw coordinates are the *last* resort — and when vision produces a point, the fusion locator snaps it back onto a structured element before acting.
- **Cross-platform coordinate system**: vision-normalized [0,1000] ↔ screenshot px ↔ logical points ↔ physical pixels, with DPI/Retina/density handled and unit-tested.
- **Honesty by construction**: missing permissions, offline devices, Wayland restrictions, unsigned WDA — reported as `permission_required` / `restricted` / `BLOCKED`, never faked as success.
- **Anti-stagnation loop guard**: same-action / same-element / same-screen (perceptual hash) detection with a recovery ladder (re-observe → alternate strategy → honest failure).
- **Security**: app/device/action/domain allowlists + sensitive-action detection (删除/支付/转账/install…) parking tasks in `WAITING_CONFIRMATION` with confirm tokens.
- **Recorder → portable DSL**: recordings become YAML scripts with *semantic locators* (never `click(432,621); sleep(2)`), replayable across platforms; a UI-test runtime reports `PASS / FAIL / SKIP / BLOCKED`.
- **Remote GPU architecture**: the 9B vision model runs on a server (OpenAI-compatible endpoint); clients only send screenshots — phones and laptops need no VRAM.

## Quick start

```bash
git clone https://github.com/q1820926174-cpu/UI-Venus-MCP.git
cd UI-Venus-MCP
pnpm install
pnpm build

export VENUS_BASE_URL=http://<gpu-host>:8300/v1   # OpenAI-compatible
export VENUS_API_KEY=<your-key>
export VENUS_MODEL=UI-Venus-2-9B-W8A8

# stdio (ZCode / Claude Code / Codex)
node dist/index.js

# Streamable HTTP (remote agents / LAN)
node dist/index.js --http --port 8765
```

Smoke-test the vision endpoint (one calibration request):

```bash
pnpm smoke:venus
```

### ZCode / Claude Code config

```json
{
  "mcpServers": {
    "ui-venus-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/UI-Venus-MCP/dist/index.js"],
      "env": {
        "VENUS_BASE_URL": "http://<gpu-host>:8300/v1",
        "VENUS_API_KEY": "<your-key>",
        "VENUS_MODEL": "UI-Venus-2-9B-W8A8"
      }
    }
  }
}
```

More configs (HTTP transport, Codex, OpenAI Agents): [examples/mcp-config.md](examples/mcp-config.md).

## Usage patterns

**Assist mode** — a multimodal agent drives; the MCP executes and grounds:

```text
computer_inspect  → screenshot + UI tree (+ optional vision description)
computer_locate   → "关闭按钮" → {element, point}   (structured first, vision fallback)
computer_action   → { type: "click", element: {...} }
computer_verify   → structured assertion, else vision verdict
```

**Delegate mode** — a text-only agent hands over the whole task:

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

Internally: `Observe → Plan → Locate → Execute → Observe → Verify → Recover/Finish`, with the state machine, security gates, and loop guard enforcing honest termination. Poll with `computer_get_task`, cancel with `computer_cancel_task`; sensitive actions return `WAITING_CONFIRMATION` + `confirmToken`.

**Record → script → replay:**

```text
computer_record_start → (drive the app via computer_action) → computer_record_to_script
```

```yaml
name: disable-auto-update
steps:
  - locate: { role: button, name: 设置 }
    action: click
  - locate: { name: 自动更新 }
    action: toggle
    value: false
assert:
  - element: { name: 自动更新 }
    property: { checked: false }
```

Replay with `computer_run_script`, or run as a UI test (`PASS/FAIL/SKIP/BLOCKED`) with `computer_run_ui_test`. DSL reference: [examples/dsl/toggle-autoupdate.yaml](examples/dsl/toggle-autoupdate.yaml).

## Platform support matrix

| Capability | Windows | Linux | macOS | Android | iOS | Browser |
|---|---|---|---|---|---|---|
| Screenshot | ✅ CopyFromScreen | ✅ import/scrot/grim | ✅ screencapture | ✅ screencap | ✅ simctl/WDA | ✅ Playwright |
| Accessibility tree | ✅ UIA | ✅ AT-SPI (pyatspi) | ✅ AX (System Events) | ✅ UIAutomator dump | ⚠️ WDA/idb | ✅ aria snapshot |
| Semantic actions | ✅ UIA patterns | ✅ doAction/setText | ✅ AXPress/AXValue | ✅ dump+tap center | ⚠️ WDA elements | ✅ role/text/testid locators |
| Global input | ✅ SendInput | ✅ xdotool / wtype | ✅ CGEvent | ✅ adb input | ⚠️ WDA/idb | ✅ keyboard/mouse |
| App control | ✅ | ✅ | ✅ `open`/AppleScript | ✅ monkey/am | ✅ simctl/WDA | n/a |
| Unicode typing | ✅ KEYEVENTF_UNICODE | ✅ xdotool type | ✅ CGEvent unicode | ⚠️ ADBKeyboard IME | ✅ WDA | ✅ |
| Vision fallback | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

⚠️ = capability depends on optional tooling/signing — the server reports exactly what is missing (`capabilities.notes`), per the honesty rules. Platform-specific setup: [docs/install/](docs/install/) — [macOS](docs/install/macos.md) · [Windows](docs/install/windows.md) · [Linux](docs/install/linux.md) · [Android](docs/install/android.md) · [iOS](docs/install/ios.md).

## The UI-Venus provider (verified endpoint contract)

The default provider speaks the OpenAI chat/completions format with
`chat_template_kwargs: {enable_thinking: false}` and grounds natural-language
elements to `[0,1000]`-normalized points. Calibrated against the W8A8 build
(2026-09-28): button at pixel (1300,740) on 1920×1080 → `[676, 680]`; the
official grounding prompt and the live verification live in
[ui-venus-service/README.md](ui-venus-service/README.md) and
[tests/e2e/venus-live.test.ts](tests/e2e/venus-live.test.ts).

Swapping providers (UI-TARS, Qwen-GUI, any VLM): implement
`ComputerVisionProvider` ([src/providers/types.ts](src/providers/types.ts))
and register it in the registry — nothing else knows which model is in use.

## Development

```bash
pnpm test                  # full hermetic suite (unit + integration + browser E2E)
pnpm test:e2e:macos        # real macOS E2E (needs permissions) — RUN_MACOS_E2E=1
pnpm test:e2e:venus        # live grounding E2E against your endpoint — RUN_VENUS_LIVE=1
pnpm typecheck && pnpm build
```

QA status per platform (what is really verified vs mocked): [docs/qa-report.md](docs/qa-report.md). Architecture deep-dive: [docs/architecture.md](docs/architecture.md).

## Repository layout

```text
src/
├── mcp/            17 tools, server assembly
├── orchestrator/   task loop, fusion locator, verifier, loop guard, security
├── providers/      ComputerVisionProvider + UI-Venus implementation + mock
├── platforms/      adapter interface, router, macos/linux/windows/android/ios/browser
├── scripting/      YAML DSL + runner      ├── recorder/   semantic recording
├── coordinate/     space transforms      ├── screenshot/ pipeline (ROI/hash/JPEG)
├── core/           types, actions, state machine, errors
ui-venus-service/   endpoint contract & serving reference
tests/              unit · integration (mock+browser+mcp) · e2e (opt-in real)
```

## License

MIT — see [LICENSE](LICENSE).
