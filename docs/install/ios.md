# iOS / iPadOS support — install & honest capability matrix

The iOS adapter (`src/platforms/ios/`) drives two **different target kinds**
(spec §10) — do not mix them up:

| Target | Schema | Transport |
|---|---|---|
| **Simulator** | `{ type: "simulator", platform: "ios", deviceId?: <udid> }` | `xcrun simctl` (+ `idb` / WDA for tree & input) |
| **Real device** | `{ type: "device", platform: "ios", deviceId: <id> }` | WebDriverAgent HTTP only |

Environment variables:

- `IOS_WDA_URL` (default `http://localhost:8100`), fallback `WDA_URL` — WebDriverAgent base URL.

The adapter never fakes success: every missing dependency shows up as an
honest capability gap (`capabilities.notes`) or a machine-readable error
(`permission_required` / `device_not_found` / `unsupported`).

---

## 1. Simulators — `xcrun simctl` (requires full Xcode)

```bash
# macOS + Xcode (Command Line Tools alone do NOT ship simctl runtimes)
xcode-select --install          # base tools
sudo xcode-select -s /Applications/Xcode.app   # point at full Xcode
xcrun --find simctl             # adapter probe — must succeed
xcrun simctl list devices -j    # discovery (name / udid / state)
xcrun simctl boot "iPhone 15"
```

What simctl gives the adapter: device discovery, full-screen screenshots
(`simctl io <udid> screenshot -`, temp-file fallback for older Xcode),
app launch/terminate/install/openurl.

What simctl can **never** give: accessibility tree, touch/keyboard input,
the home button. That is what idb / WDA are for.

### 1a. idb — accessibility tree + touch input on simulators

[Meta's iOS Development Bridge](https://github.com/facebook/idb) is the
simulator fallback for `accessibility` (UI tree, `locate()`) and
`globalInput` (tap/text/swipe):

```bash
brew install idb-companion
pip install fb-idb              # provides the `idb` CLI
which idb                       # adapter probe — must succeed
idb ui describe-all --udid <udid>   # AX elements (label/type/frame)
```

> If idb is missing the adapter reports `accessibility=false` with the note
> `install idb: brew install idb-companion; pip install fb-idb` and
> tree/`locate()` degrade to **vision-only** (screenshot + coordinates).
> That degradation is intentional and documented, not a failure.

idb also provides `idb describe --udid <udid>` whose `screen_dimensions`
(width/height/scale) is the only way to learn the screenshot
points→pixels scale without WDA.

### 1b. Simulator scale honesty

`simctl` screenshots are **device pixels** (@2x/@3x); actions run in
**logical points**. The scale is resolved as:

1. idb `describe` → `screen_dimensions.scale` (exact), else
2. WDA `window/size` (points) vs. screenshot pixel height (derived), else
3. **assumed 1 with an explicit `capabilities.notes` warning** — treat
   screenshot-space points as approximate in that mode.

### 1c. Simulator + WDA

If WDA is reachable (`IOS_WDA_URL`) it is **preferred** for tree and input
even on simulators; simctl remains the fallback for screenshots and app
management. This gives semantic element handles (`click` by accessibility
id) instead of coordinate taps.

---

## 2. Real devices — WebDriverAgent (WDA)

Everything on a physical iPhone/iPad goes through
[WebDriverAgent](https://github.com/appium/WebDriverAgent) over HTTP
(Appium-compatible subset). Four prerequisites — the adapter probes
`GET /status` and reports `permission_required` with exactly these hints
when any of them is missing; it never pretends they pass:

1. **Developer Mode** — Settings → Privacy & Security → Developer Mode →
   On (iOS 16+; requires a restart).
2. **Signing & provisioning** — build WDA in Xcode with a development
   team; the profile must include the specific device. Free accounts work
   but expire every 7 days (rebuild required).
3. **Trust this computer** — unlock the device and accept the prompt;
   device must stay unlocked for WDA to respond.
4. **Port forwarding** — WDA listens on the device, not on your network:

   ```bash
   brew install libimobiledevice
   iproxy 8100 8100 <udid>        # keep running; then:
   curl http://localhost:8100/status
   ```

Build WDA:

```bash
git clone https://github.com/appium/WebDriverAgent.git
open WebDriverAgent.xcodeproj   # set your team on the WebDriverAgent target
xcodebuild -project WebDriverAgent.xcodeproj \
  -scheme WebDriverAgentRunner -destination 'id=<udid>' test
```

Or use a pre-built WDA via Appium (`appium --relaxed-security`) — any
server speaking the same endpoints works. The adapter implements:
`/status`, `/session`, `/session/:id/window/size`, `/source?format=json`,
`/elements` (accessibility id), `/element/:id/click|value|clear`,
`/wda/tap/0`, `/wda/doubleTap`, `/wda/touchAndHold`,
`/wda/dragfromtoforduration`, `/wda/pressHome`, `/wda/type`, `/wda/keys`,
`/wda/activeAppInfo`, `/wda/apps/launch|terminate|activate|list`,
`/session/:id/url`, `/screenshot`.

---

## 3. What works where (honest matrix)

| Capability | device + WDA | device, no WDA | sim + simctl + WDA | sim + simctl + idb | sim, simctl only | sim, nothing |
|---|---|---|---|---|---|---|
| `screenshot` | yes | no | yes (WDA) | yes (simctl, scale via idb) | yes (scale assumed 1, noted) | no |
| `accessibility` (tree/locate) | yes | no | yes | yes | no (vision-only) | no |
| `globalInput` (tap/type/swipe) | yes | no | yes | yes | no | no |
| `appControl` (launch/terminate) | yes (WDA) | no | yes | yes | yes | no |
| `windowControl` | no | no | no | no | no | no |
| `clipboard` | no (not implemented) | no | no | no | no | no |
| `multiDisplay` / `dom` | no | no | no | no | no | no |

Action-level notes (all reported as `unsupported` with hints at runtime):

- **`back`** — iOS has no global back key. Tap the app's back button
  (`locate` by label) or edge-swipe from the left edge.
- **`home`** — WDA only (`POST /wda/pressHome`); neither simctl nor idb
  can press it.
- **`hotkey`** — unsupported (no global modifier keys).
- **`press`** — software-keyboard characters only (enter/backspace/tab/
  single chars) via WDA; `F5`-style hardware keys don't exist.
- **`right_click` / `move`** — use `long_press`; touch has no hover.
- **`set_value`/`clear`** — WDA only (idb can type but not clear).
- **`double_click` on idb** — two rapid taps (no native double-tap);
  **`long_press` on idb** — zero-length held swipe (approximation).

Coordinate space: all element bounds and input coordinates are **logical
points** (`attributes.boundsSpace = "logical"`); screenshots carry their
`scale` so screenshot-pixel/normalized/physical spaces convert cleanly.

---

## 4. What could NOT be verified on the dev host (important)

This implementation was developed on a macOS host **without Xcode**
(`xcrun --find simctl` fails) and **without idb**. All logic is covered by
48 hermetic unit tests (`tests/unit/ios.test.ts`) against JSON fixtures
and mocked exec/fetch, but the following can only be verified on a
provisioned host and may need adjustments:

- Real `simctl`/`idb` CLI output quirks (the parsers are tolerant:
  AX*/bare key spellings, CGRect strings and objects, XML and OpenStep
  plists — both encodings are fixture-tested, real-world output may vary
  by tool version).
- Live WDA server responses (fixtures mirror the documented wire format;
  WDA versions differ, e.g. top-level vs. nested `sessionId`).
- Screenshot content fidelity, scale derivation against real @3x devices,
  gesture timing feel, and long-press approximations.
- The full WDA endpoint set on older WDA builds.

Smoke-test on a provisioned machine:

```bash
curl http://localhost:8100/status                 # WDA reachable?
xcrun simctl list devices -j | head               # simulators?
npx vitest run tests/unit/ios.test.ts             # logic (hermetic)
```
