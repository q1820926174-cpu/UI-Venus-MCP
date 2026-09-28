# MCP Tool Contract (17 tools, spec §16)

All tools return JSON text content; screenshot-bearing tools append an
`image` content block. Errors are structured:
`{"error": {"code", "message", "details?", "hint?"}}` with codes from
`invalid_request | unsupported | permission_required | restricted |
device_offline | device_not_found | element_not_found | target_not_found |
timeout | provider_error | cancelled | confirmation_required |
security_blocked | stalled | internal_error`.

## Common parameter: `target` (spec §14)

```jsonc
{ "type": "local",  "platform": "auto" }                       // this machine (auto-detect)
{ "type": "device", "platform": "android", "deviceId": "emulator-5554" }
{ "type": "device", "platform": "ios",     "deviceId": "<udid>" }
{ "type": "simulator", "platform": "ios" }                     // booted simulator
{ "type": "browser", "platform": "browser",
  "browser": "chromium", "url": "https://…", "cdpEndpoint": "http://…:9222" }
```

Omitting `target` defaults to the local machine. `remote` / `vm` are
reserved and currently report `unsupported`.

## Targets

### `computer_list_targets`
Enumerate servable targets with honest availability. →
`{"targets": [{id, platform, type, name, available, reason?, details?}]}`
Unavailable platforms are listed *with the reason* (e.g. "host platform is
darwin; Windows adapter needs a Windows host").

### `computer_get_target` `{target?}`
Resolve + probe one target. → `{target: TargetInfo, capabilities: {screenshot,
accessibility, dom, globalInput, windowControl, appControl, clipboard,
multiDisplay, notes[]}}`.

## Observation

### `computer_get_state` `{target?}`
Cheap structural state (no screenshot): screen, activeApp, windows, UI tree,
capabilities.

### `computer_inspect` `{target?, focus?, includeTree?, maxTreeDepth?}`
Full observation + screenshot (returned as an image block) + optional
vision description focused on `focus`.

### `computer_screenshot` `{target?, windowId?, displayId?, region?, savePath?}`
Capture; returns metadata `{width, height, scale, origin, orientation, hash,
savedTo?}` + image block.

## Locate & act

### `computer_locate` `{target?, instruction, descriptor?, preferStructured?}`
Fusion locate (structured → vision → snap-back). →
`{source: "structured"|"vision"|"not_found", element?, point?, normalized?,
confidence, raw}`. `point` is in screenshot pixel space; `element` is a
full ElementRef usable in `computer_action`.

### `computer_action` `{target?, action, confirmToken?}`
Execute one unified action (spec §17):

```jsonc
{ "type": "click", "element": {…} }            // semantic first
{ "type": "click", "point": {"x": 541, "y": 411, "space": "screenshot"} }
// double_click right_click long_press move drag swipe scroll
// type set_value clear press hotkey select toggle invoke
// launch_app terminate_app focus back home wait finish fail
```

→ `{ok, method: "semantic"|"coordinate"|"system", element?, point?, error?,
durationMs, detail?}`. Sensitive actions return
`{ok:false, state:"WAITING_CONFIRMATION", confirmToken, reason}` — re-call
with the same action + `confirmToken` to approve.

### `computer_step` `{target?, goal, language?, dryRun?}`
One autonomous loop iteration: observe → vision provider decides → execute
(unless `dryRun`). → `{thought, action, isFinal, result?, screenshotHash?}`.

## Tasks

### `computer_execute_task` `{target?, task, mode?, maxSteps?, language?, wait?, confirmToken?}`
Full delegation (§22). `mode`: `delegate|assist|direct|auto` (loop runs for
`delegate|auto`; others are tool-level modes). Returns the task record
immediately, or awaited with `wait:true`. Sensitive steps park the record
in `WAITING_CONFIRMATION` with `pendingConfirmation.token`.

### `computer_get_task` `{taskId}` → full record: state, steps[], outcome,
`pendingConfirmation`, timing.
### `computer_cancel_task` `{taskId}` → `{ok}`.

Task states (§36): `CREATED OBSERVING PLANNING LOCATING EXECUTING VERIFYING
RECOVERING WAITING_CONFIRMATION SUCCESS FAILED BLOCKED CANCELLED`.

## Verify

### `computer_verify` `{target?, goal? , assertion?}`
Structured assertion (§23) or NL goal verification:

```jsonc
{"assertion": {"element": {"name": "自动更新"},
               "property": {"checked": false}}}
// property: checked | exists | valueEquals | valueContains | textVisible
```

→ `{pass, source: "structured"|"vision", evidence, confidence, raw}`.

## Recorder

### `computer_record_start` `{target?}` — begin recording on that session.
### `computer_record_stop` `{target?}` — stop; returns entries
(timestamp, platform, app, action, element, method, ok, before/after
screen hashes).
### `computer_record_to_script` `{target?, name?, stop?}` — convert the
recording into the portable YAML DSL (semantic locators; coordinate steps
carry explicit fragility markers). → `{script, yaml}`.

## Scripting & testing

### `computer_run_script` `{target?, yaml | path}`
Parse + run the DSL (§26):

```yaml
name: disable-auto-update
target: { type: local, platform: auto, app: GoldAgent }
steps:
  - locate: { role: button, name: 设置 }
    action: click
  - locate: { name: 自动更新 }
    action: toggle
    value: false
  - action: wait
    durationMs: 500
assert:
  - element: { name: 自动更新 }
    property: { checked: false }
```

`locate` supports `role | name | text | resourceId | css | xpath | testId |
index`. → `{script, status: PASS|FAIL|BLOCKED|SKIP, steps[], assertions[],
recorder}`.

### `computer_run_ui_test` `{target?, cases: [{name, yaml}]}`
Run UI test cases (§27). → per-case `{name, status: PASS|FAIL|SKIP|BLOCKED,
reason?, detail?}` + suite summary + `execution` class
(`real-device|emulator|mock|static|unverified`). BLOCKED is reserved for
environmental restrictions.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `VENUS_BASE_URL` | `http://36.138.102.62:8300/v1` | OpenAI-compatible vision endpoint |
| `VENUS_API_KEY` | — | bearer key (required for vision features) |
| `VENUS_MODEL` | `UI-Venus-2-9B-W8A8` | model name |
| `VENUS_TIMEOUT_MS` | 120000 | provider request timeout |
| `VENUS_ENABLE_THINKING` | `false` | chat_template_kwargs |
| `VENUS_MIN/MAX_PIXELS` | 3136 / 12845056 | image resize bounds |
| `VENUS_ALLOW_INSECURE_HTTP` | `true` | allow plain-http endpoints |
| `CUMCP_MAX_STEPS` | 30 | delegate loop cap |
| `CUMCP_TASK_TIMEOUT_MS` | 600000 | wall-clock task cap |
| `CUMCP_MAX_STAGNATION` | 3 | identical-step tolerance |
| `CUMCP_CONFIRM_SENSITIVE` | `true` | confirmation gate |
| `CUMCP_SENSITIVE_KEYWORDS` | 删除/delete/pay/… | comma list |
| `CUMCP_ALLOWED_ACTIONS` / `_APPS` / `_DEVICES` / `_DOMAINS` / `CUMCP_BLOCKED_APPS` | unset | policy allow/deny lists |
| `CUMCP_SCREENSHOT_FORMAT` / `CUMCP_JPEG_QUALITY` / `CUMCP_MAX_DIMENSION` | png / 80 / 2560 | screenshot pipeline |
