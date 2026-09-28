# macOS Setup

The macOS adapter is the most complete native implementation and is
verified end-to-end on this project's development machine.

## Requirements

- macOS 12+ (Apple Silicon and Intel)
- Node.js ≥ 20
- Permissions (below)

## Permissions (spec §34)

| Permission | Enables | Grant at | Detection |
|---|---|---|---|
| **Screen Recording** | screenshots (screencapture) | System Settings → Privacy & Security → Screen Recording → enable your terminal/host app | `capabilities.screenshot=false` until granted |
| **Accessibility** | AX tree, semantic actions, CGEvent input | System Settings → Privacy & Security → Accessibility → enable your terminal/host app | `capabilities.accessibility=false` + all input fails with `permission_required` |
| **Automation (Apple Events)** | System Events process/window control | prompt on first use → Allow | osascript errors surface as `internal_error` with the dialog hint |

After granting, **restart the terminal/host app** (macOS caches TCC grants
per running process).

## What works

- Screenshots: full screen, display, window region (`-R`), Retina-aware
  (scale from CoreGraphics display bounds vs pixels)
- AX tree: System Events traversal (depth/node capped) with stable
  resolvable element paths
- Semantic actions: `click`/`invoke` via AXPress, `set_value` via AXValue,
  `toggle` with state check; coordinate fallback via CGEvent
- Input: mouse move/click/double/right/drag/scroll, unicode typing
  (CGEventKeyboardSetUnicodeString — CJK safe), hotkeys with
  cmd/ctrl/option/shift/fn
- Apps/windows: list, launch (`open -a`), terminate, focus/raise

## Known limitations (honest)

- Raw `AXUIElement` C API is unavailable inside some sandboxed runtimes
  (-25201); the adapter therefore uses System Events (AppleScript) for AX
  — same grant, different bridge.
- Elevated/secure fields (passwords) and system UI (Dock, menu extras of
  other TCC contexts) are not inspectable.
- Secondary-display origin is approximated by horizontal stacking
  (single-display setups are exact; multi-display origin comes from
  system_profiler which lacks arrangement data).

## Verify

```bash
RUN_MACOS_E2E=1 pnpm test:e2e:macos
```

Expect: honest capability JSON, a real screenshot with hash, the real AX
tree of your frontmost app, a located button, and a harmless 1px mouse
probe.
