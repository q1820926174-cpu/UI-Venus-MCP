# Android Setup

The Android adapter is a real adb implementation (discovery, UIAutomator
parsing, semantic-first actions). Its parsing/decision logic is
fixture-tested (41 hermetic unit tests); **on-device E2E was not run
during development** — run the acceptance below on your device first.

## Requirements

- Android device or emulator, USB debugging (or `adb connect <ip>:5555`)
- adb on the host:
  - macOS: `brew install --cask android-platform-tools` (or Android Studio's
    `~/Library/Android/sdk/platform-tools`)
  - Linux: `sudo apt install adb`
  - Windows: SDK platform-tools, added to PATH
  - or set `ANDROID_HOME` / `ANDROID_SDK_ROOT`

```bash
adb devices          # must list your device as "device" (not unauthorized/offline)
```

`unauthorized` → accept the RSA dialog on the device (reported as
`permission_required`); `offline` → `device_offline`.

## What works

- Device discovery (USB + adb-over-TCP), multi-device targeting via
  `target.deviceId`
- UI hierarchy via `uiautomator dump` → semantic locating by
  resource-id / text / content-desc / class (CJK text included)
- Semantic-first actions: every action re-dumps the hierarchy, re-matches
  the element, then taps the matched center (plain adb exposes no remote
  invoke — this is the most reliable semantic equivalent, and it is
  reported as such in `capabilities.notes`)
- Typing: ASCII via `input text`; **full Unicode/CJK requires the
  ADBKeyboard IME** (auto-probed; install for CJK automation):
  ```bash
  adb install ADBKeyboard.apk && adb shell ime set com.android.adbkeyboard/.AdbIME
  ```
- System: back/home/recents, launch (`monkey`/`am start`), terminate
  (`am force-stop`), screenshots (`screencap`), rotation, top activity,
  third-party package list
- Coordinates: physical pixels; scale = density/160 (`wm size`/`wm density`)

## Honest capability matrix

| Capability | Value | Condition |
|---|---|---|
| screenshot | ✅ | device online |
| accessibility | ✅ | uiautomator dump works (probed on first use) |
| globalInput | ✅ | adb input |
| Unicode typing | ⚠️ | ADBKeyboard IME installed, else ASCII-only (stated in notes) |
| windowControl / clipboard / dom / multiDisplay | ❌ | plain adb cannot serve these — reported honestly |

## On-device acceptance (run before production use)

```bash
pnpm test && \
node dist/index.js   # then via MCP:
# computer_get_target {type:"device",platform:"android",deviceId:"<serial>"}
# computer_locate {instruction:"设置"}     → structured element?
# computer_action {action:{type:"back"}}   → device responds?
```

Mark the result in your own QA records as `real-device`; anything not
re-verified on hardware inherits the `unverified` class from
[docs/qa-report.md](../qa-report.md).
