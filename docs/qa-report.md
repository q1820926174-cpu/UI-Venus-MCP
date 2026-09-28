# QA Report

Generated 2026-09-28 (updated after the interactive-session Windows E2E and
the official UI-Venus protocol alignment). Per platform (spec §46), each
line item states its verification class: **real-device / emulator / mock /
static / unverified**. Nothing is claimed as verified that was not actually
executed.

## Test totals (this repo, hermetic suite `pnpm test`)

| Suite | Tests | Status |
|---|---|---|
| unit (coordinate, actions, state machine, loop guard, security, DSL, Venus official-protocol prompts+client, screenshot pipeline 256-bit aHash, verifier, locator fusion) | 130+ | ✅ all pass |
| unit/platform (linux 55 · android 41 · ios 48 · windows 24) | 168 | ✅ all pass |
| integration (mock delegate loop with per-step verification, §44 fallback, recorder→DSL→replay, multi-device isolation, security confirmations, **MCP server over SDK client**) | 41 | ✅ all pass |
| integration browser (real Chromium E2E) | 17 | ✅ all pass |
| e2e macOS (real machine, opt-in `RUN_MACOS_E2E=1`) | 5 | ✅ 5/5 executed on the dev Mac |
| e2e UI-Venus live (real W8A8 endpoint, opt-in `RUN_VENUS_LIVE=1`) | 3 | ✅ 3/3 executed against the live endpoint |

Full run: **311 passed / 0 failed** (+9 opt-in real E2E executed separately).

## Windows

### Real-machine E2E — host DESKTOP-N8HLVGG, Win11 Pro build 26200, user gold

**Phase 1 — SSH / session 0** (all commands verbatim, honest results):

| Check | Result | Verdict |
|---|---|---|
| Session reality | `query user`: gold session 1 `Disc`; SSH runs in session 0; integrity High (S-1-16-12288) | works-over-SSH |
| UIA tree | works, own (empty) session-0 desktop only; session-1 windows invisible (`PROCESS_NOT_FOUND`) | blocked |
| GDI capture | `The handle is invalid` (CAPTURE_FAILED, exit 8) | blocked |
| SendInput | `injected 0 of 1 events (Win32Error=5)` | blocked |
| GUI app launch | notepad pid exits immediately (no desktop) | blocked |
| Display metrics | works (1024×768 virtual screen in session 0) | works-over-SSH |
| RuntimeId stability | rid changes across PS processes → **signature fallback added & verified** (`matchedBy:"signature"`) | fixed + verified |

**Phase 2 — interactive session 1** (tscon-activated console + `schtasks /IT`
harness, `session1-e2e.ps1`, final green run 23:26):

| Check | Result | Verdict |
|---|---|---|
| Session context | sessionId=1, interactive=true | ✅ real-device |
| GDI capture | 1920×1080 PNG, 189.6 KB, blackRatio=0 → REAL_IMAGE | ✅ real-device |
| SendInput move | ok:true, cursor read-back (960,540) | ✅ real-device |
| SendInput key | ok:true | ✅ real-device |
| UIA tree (charmap) | 14 elements, Edit `复制字符(A):` rid 42,329396 | ✅ real-device |
| UIA setValue (CJK) | ok:true matchedBy:runtimeId, value verbatim | ✅ real-device |
| UIA read-back | containsExpected=true | ✅ real-device |
| SendInput unicode type (CJK) | 14 units, appended verified by read-back | ✅ real-device |
| Clean close | CloseMainWindow | ✅ real-device |

**Windows closed loop: PASS (real machine, interactive session).**
Bugs found & fixed by real testing: PS1 backtick parse error, capture exit
code, non-ASCII stderr, cross-process RuntimeId instability (signature
fallback), mojibake from missing UTF-8 BOM (all scripts now ship BOM),
`\r`-tolerant setValue verification, packaged-Notepad pid/window mismatch
(documented; classic Win32 apps used for acceptance).

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
| Delegate closed loop (Calculator) with LIVE UI-Venus: launch → autonomous click on "7" (official protocol, window-scoped screenshot) → per-step vision verification passed → AX-tree ground truth shows display "7" → SUCCESS | executed once end-to-end (further runs cancelled per owner request to stop mac testing) | real-device |
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

## Vision provider (UI-Venus-2-9B-W8A8) — OFFICIAL protocol aligned

Aligned 2026-09-28 against the official sources: ModelScope model card
(Inference Configuration) + `inclusionAI/UI-Venus` repo @ UI-Venus-2,
`models/computer/computer_example.py` and `models/grounding`.

| Item | Result | Class |
|---|---|---|
| Grounding: official prompt, single-shot, thinking off, temp 0, [0,1000] | live E2E pass (`[676,684]` for expected `[677,685]`) | real |
| Agentic loop: OFFICIAL system prompt (verbatim) | implemented; agent turns temp 1.0 + thinking ON per model card | real (Calculator run) |
| Output format `<think>…</think>` / `<action>Click(box=(x, y))</action>` | parser implemented incl. reasoning_content merge; live-verified | real + mock |
| Official action grammar (Click/Drag/Swipe/Type/Hotkey/Sequence/Finished/CallUser), positional+named args, AST-safety (no eval; rejects `__import__`/kwargs/nested Sequence) | 19+ unit tests + live | mock + real |
| Coordinate rule `int(v × size / 999)` clamped | unit + live (0-999 space confirmed; earlier 0-1000 assumption corrected) | real |
| Multi-turn: accepted-only assistant history + last-N screenshots (default 2) | unit + live | mock + real |
| Thinking control: `chat_template_kwargs.enable_thinking` sent on EVERY call (server thinks by default) | bug found live (verify returned empty content with everything in reasoning_content) → fixed | real |
| Infeasible-element handling (`[-1,-1]` → `not_found`) | live E2E pass | real |
| HTTP client robustness (retry, timeout, auth, insecure-http policy, reasoning merge) | unit tests with mocked fetch | mock |

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
| Windows | **PASS (interactive session)** — full closed loop: capture + input + UIA semantic write/read-back + CJK typing; session-0 SSH limits honestly documented | real-device (session 1) + mock (parsing) |
| Linux | CODE COMPLETE — 55 mock tests; no real desktop run | mock |
| macOS | PASS on core paths + delegate closed loop (Calculator × live Venus, single run) | real-device |
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
