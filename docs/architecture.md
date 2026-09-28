# Architecture

## Overview

UI-Venus MCP is a **Cross-Platform Computer-Use Runtime** exposed over MCP.
Everything above the platform layer is platform-agnostic; every platform
difference is sealed inside an adapter.

```text
ZCode / Claude Code / Codex / OpenAI Agents / 自研 Agent / 纯文本模型
                         │
                         │ MCP (stdio / Streamable HTTP §39)
                         ▼
        ┌────────────────────────────────────────────┐
        │              MCP Server (17 tools)         │
        ├────────────────────────────────────────────┤
        │ Orchestrator (delegate/auto loop)          │
        │   ├── TaskStateMachine        (§36)        │
        │   ├── Security policy + confirmations (§35)│
        │   ├── LoopGuard stagnation guard    (§32)  │
        │   ├── FusionLocator                 (§21)  │
        │   └── Verifier                      (§23)  │
        ├────────────────────────────────────────────┤
        │ Recorder → Automation DSL → Test Runtime   │
        │   (§24-§27: record/replay/UI-test)         │
        ├────────────────────────────────────────────┤
        │ Vision provider registry (§19)             │
        │   └── UI-Venus (default) · mock · yours    │
        ├────────────────────────────────────────────┤
        │ Platform Router (§14/§41 target sessions)  │
        └──────┬─────────┬─────────┬──────────┬──────┘
               ▼         ▼         ▼          ▼
           Windows     Linux     macOS   Android/iOS/Browser
```

## Design rules

1. **Unified Target schema (§14).** Every tool accepts an explicit
   `target` — nothing implicitly controls "the local Windows box".
   `local|device|simulator|browser` today; `remote|vm` reserved in the
   same schema for future adapters.
2. **One Action vocabulary (§17).** 24 unified actions (`click … finish/fail`).
   Adapters translate: `click(elementRef)` → UIA Invoke / AXPress /
   AT-SPI doAction / UIAutomator tap / XCUITest tap / Playwright click /
   coordinate click as the last resort.
3. **ElementRef over coordinates (§18).** Elements carry semantic identity
   (`source: uia|atspi|ax|uiautomator|xcuitest|dom|vision`, role, name,
   bounds in screenshot pixel space). Coordinates never become the
   system's currency; they are attached evidence.
4. **Structure first, vision as fallback (§4/§21/§44).** The fusion
   locator tries: explicit descriptor → adapter semantic locator →
   UI-tree heuristic match → vision grounding → point-to-element
   snapping. The §44 fallback property (structured deliberately broken →
   vision completes the task) is covered by integration tests.
5. **Honest capability reporting (§33/§34).** Adapters probe tooling and
   permissions at `open()`; the Orchestrator maps
   `permission_required | restricted | unsupported | device_offline` to
   `BLOCKED` — never a fake success. Verified examples: macOS AX/screencapture
   permission checks, Wayland's denied global input, iOS WDA signing.
6. **Rich Observations (§20).** `platform, screen, screenshot(+hash),
   activeApp, uiTree, dom, windows, capabilities` — all optional per
   platform. The vision provider sees Observations + Goal + History, and
   knows nothing about MCP or platforms (§19).

## Coordinate pipeline (§29/§30)

```text
UI-Venus [0,1000] ──×(imgW,imgH)──▶ screenshot px ──origin,scale──▶ logical ──×scale──▶ physical
```

- Windows/Linux/X11: screenshot px = physical px (scale 1, multi-monitor
  via virtual-screen origin).
- macOS: logical points; screenshot px = logical × display scale
  (Retina-aware, origin = capture region origin).
- Android: physical px; scale = density/160.
- iOS: points; scale from WDA metrics / idb (`@2x`/`@3x`).
- Browser: CSS px; scale = deviceScaleFactor.

All transforms are pure functions with unit tests
(`tests/unit/coordinate.test.ts`), including the calibrated Venus case.

## Task orchestration (§22/§32/§35/§36)

```text
CREATED → OBSERVING → PLANNING → LOCATING → EXECUTING → VERIFYING → SUCCESS
                    ↺ RECOVERING (loop-guard ladder)      ⇄ WAITING_CONFIRMATION
                terminal: FAILED (bad outcome) · BLOCKED (environment) · CANCELLED
```

- **Security policy**: app/device/action/domain allowlists; sensitive
  actions (keyword classes: delete/pay/transfer/install/permission…)
  park the task in `WAITING_CONFIRMATION` and return a `confirmToken`;
  `computer_execute_task {confirmToken}` resumes it.
- **LoopGuard**: fingerprints `(actionSummary, elementId, aHash(screen))`;
  N-identical-step streaks, unchanged-screen failures, repeated identical
  failures escalate: re-observe → alternate strategy → honest FAILED with
  evidence.
- **Verifier**: structured assertions (checked/exists/value/textVisible)
  from the UI tree first; NL goals get a toggle-state heuristic; vision
  verdict only when structure can't answer — recorded with `source` so
  evidence is never ambiguous.

## Screenshot pipeline (§31)

Raw platform capture → decode → aHash (stagnation) → ROI crop →
downscale (vision token saver, default ≤2560 px) → PNG/JPEG (quality
configurable) → `Screenshot{scale, origin, orientation}`. Pure-JS
(pngjs/jpeg-js) to avoid native builds.

## Recording & DSL (§24–§27)

The recorder wraps executed actions (before/after screen hashes, semantic
elements, methods). `record_to_script` emits the portable YAML DSL with
semantic locators; coordinate-only actions are emitted with explicit
fragility markers instead of silent `click(432,621)`. The DSL runner
resolves locators through the same fusion path and executes through the
same adapters — one script, every platform. `computer_run_ui_test`
returns per-case `PASS / FAIL / SKIP / BLOCKED`; BLOCKED is reserved for
environmental restrictions (permissions, offline devices, signing).

## Multi-device sessions (§41)

The router keys sessions by `platform:deviceId` and assigns canonical
session ids; per-session state (history, recordings, screenshots) never
crosses devices. Device allowlists gate access.

## Extension points

| Want to add… | Do this |
|---|---|
| A new vision model | Implement `ComputerVisionProvider`, register in `src/providers/registry.ts` |
| A new platform (RDP/VNC/VM/cloud desktop) | Implement `PlatformAdapter`, add an entry in `src/platforms/register.ts`; `remote|vm` targets already parse |
| New unified actions | Extend the zod union + `ACTION_TYPES`; adapters map them natively |
| Transport (WebSocket, etc.) | `src/index.ts` — transports are independent of tool logic |
