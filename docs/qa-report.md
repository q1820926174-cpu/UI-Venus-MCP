# QA Report

Generated 2026-09-28. Per platform (spec §46), each line item states its
verification class: **real-device / emulator / mock / static / unverified**.
Nothing is claimed as verified that was not actually executed.

## Test totals (this repo, hermetic suite `pnpm test`)

| Suite | Tests | Status |
|---|---|---|
| unit (coordinate, actions, state machine, loop guard, security, DSL, Venus prompts/client, screenshot pipeline, verifier, locator fusion) | 95+ | ✅ all pass |
| unit/platform (linux 55 · android 41 · ios 48) | 144 | ✅ all pass |
| integration (mock delegate loop, §44 fallback, recorder→DSL→replay, multi-device isolation, security confirmations, **MCP server over SDK client**) | 24 | ✅ all pass |
| integration browser (real Chromium E2E) | 17 | ✅ all pass |
| e2e macOS (real machine, opt-in `RUN_MACOS_E2E=1`) | 5 | ✅ 5/5 executed on the dev Mac |
| e2e UI-Venus live (real W8A8 endpoint, opt-in `RUN_VENUS_LIVE=1`) | 3 | ✅ 3/3 executed against the live endpoint |

Full run: **303 passed / 0 failed** (+8 opt-in real E2E executed separately).

## Windows

| Item | Result | Class |
|---|---|---|
| Adapter implementation (UIA tree, SendInput, CopyFromScreen, honest UAC/integrity notes) | delivered | static |
| UIA JSON parsing / RuntimeId locate / tree building | unit tests with fixtures pass | mock |
| Real-machine E2E (intranet test host DESKTOP-N8HLVGG, Win11 build 26200, via `ssh goldagent-151`) | see final Windows section — SSH key access was installed mid-development; results recorded by the acceptance run | real-device / unverified |

Environment honesty: elevated (admin/UAC) windows are not automatable from a
non-elevated process; SSH service sessions have no interactive desktop —
visual acceptance requires the signed-in console session. The adapter
reports both facts in `capabilities.notes` instead of guessing.

## Linux

| Item | Result | Class |
|---|---|---|
| Adapter (X11: xdotool/wmctrl/import·scrot + AT-SPI via pyatspi; Wayland: grim/wtype/ydotool, portal-aware) | delivered | static |
| Session detection, wmctrl/xdotool/AT-SPI parsing, restricted-path honesty, capability matrix | 55/55 unit tests (mocked exec) | mock |
| Real desktop E2E | **not executed** (dev host is macOS) | unverified |

## macOS

| Item | Result | Class |
|---|---|---|
| Screenshot (screencapture, Retina scale, hash) | executed on dev Mac | real-device |
| AX tree of frontmost app + stable element paths + locate | executed (ZCode window: tree read, 3 buttons located) | real-device |
| CGEvent input probe (1px mouse moves) | executed, no TCC denial | real-device |
| Delegate pipeline against a live app | not yet executed (see Future work) | unverified |
| Permissions honesty | `capabilities.accessibility/screenshot` reflect actual TCC state | real-device |

## Android

| Item | Result | Class |
|---|---|---|
| Adapter (adb discovery, uiautomator dump parser incl. CJK, semantic-first re-dump-then-tap, ADBKeyboard unicode path, wm/density scale) | delivered | static |
| Parsing / locating / decision logic (incl. stale-element fallback, device-state errors) | 41/41 unit tests (mocked adb + fixture XML) | mock |
| Real device / emulator E2E | **not executed** (no adb on dev host) | unverified |

## iOS

| Item | Result | Class |
|---|---|---|
| Adapter (simctl; WDA REST client; idb describe-all/tree/tap; WDA>idb>simctl capability layering) | delivered | static |
| Parsing / capability matrix / error taxonomy | 48/48 unit tests (fixtures for both encodings seen in the wild) | mock |
| Real Simulator / device E2E | **not executed** (no Xcode on dev host: `xcrun --find simctl` fails; no idb) | unverified |

Signing/Developer-Mode/Trust requirements for real devices are documented in
[install/ios.md](install/ios.md); the adapter reports `permission_required`
with those hints when WDA is unreachable.

## Browser

| Item | Result | Class |
|---|---|---|
| Real Chromium E2E on `file://` fixture: role/testid/css locate, semantic click verified via DOM effect, login flow, toggle+read state, select by label, scroll, hotkey, dialog auto-accept, PNG screenshot (decodable, ROI crop), aria-snapshot tree, history back, multi-tab focus switch, honest `unsupported` for launch_app | **17/17 pass, twice consecutively (~3 s each)** | real (headless Chromium on dev Mac) |
| Firefox / WebKit engines | same adapter code path (Playwright), not separately executed | unverified |
| Vision fallback in browser | covered via mock-provider integration (§44 test); live-Venus browser run not executed | mock |

## Vision provider (UI-Venus-2-9B-W8A8)

| Item | Result | Class |
|---|---|---|
| Endpoint contract (OpenAI format, `enable_thinking:false`, min/max_pixels) | verified against live endpoint | real |
| Coordinate space calibration | button at pixel (1300,740) on 1920×1080 → model `[676,680]` (expected `[677,685]`; ≈5/1000 error) — normalized [0,1000] confirmed | real |
| Grounding prompt (official usage) | live E2E pass | real |
| Agent-step parsing (Thought/Action, **named args** `click(x=676, y=683)` observed live, code fences, CJK thoughts) | live E2E pass + unit tests | real + mock |
| Infeasible-element handling (`[-1,-1]` → `not_found`) | live E2E pass | real |
| HTTP client robustness (retry, timeout, auth, insecure-http policy) | unit tests with mocked fetch | mock |

## Cross-cutting

| Item | Result | Class |
|---|---|---|
| Coordinate transforms (normalized↔screenshot↔logical↔physical, Retina/DPI) | unit tests incl. the calibrated live case | mock + real calibration input |
| State machine legality (§36) | unit tests | mock |
| Security: sensitive-action parking, confirm tokens, allow/deny lists | integration tests | mock |
| Loop guard stagnation ladder (§32) | integration test (identical-click loop → honest FAILED) | mock |
| §44 fallback (structured disabled → vision completes) | integration test | mock |
| Recorder → DSL → replay round-trip | integration test | mock |
| MCP stdio transport | smoke: initialize + 17 tools + live `computer_get_state` against real macOS adapter | real |
| MCP Streamable HTTP transport | smoke: initialize + tools/list over HTTP (stateless mode) | real |
| Multi-device session isolation (§41) | integration test | mock |

## Summary matrix (spec §46)

| Platform | Status | How verified |
|---|---|---|
| Windows | PARTIAL — code + mock-verified parsing; real-host acceptance depends on the SSH E2E outcome recorded above | mock (+ real host access installed; see Windows section) |
| Linux | CODE COMPLETE — 55 mock tests; no real desktop run | mock |
| macOS | PASS on core paths | real-device |
| Android | CODE COMPLETE — 41 mock tests; needs on-device acceptance | mock |
| iOS | CODE COMPLETE — 48 mock tests; needs Xcode/simctl host | mock |
| Browser | PASS (Chromium) | real (headless) |
| UI-Venus provider | PASS | real endpoint |

## Future work (explicitly not done)

1. Real-device E2E for Linux/Android/iOS/Windows delegate flows (blocking
   infra documented in each install guide).
2. Firefox/WebKit browser engine runs.
3. macOS delegate E2E against Calculator/TextEdit (primitives verified
   individually; full loop untested).
4. `remote|vm` targets (RDP/VNC/SPICE adapters) — schema reserved,
   adapters not implemented.
