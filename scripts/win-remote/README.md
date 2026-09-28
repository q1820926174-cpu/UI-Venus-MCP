# win-remote — Windows acceptance probe (self-contained)

`probe.ps1` is a single-file PowerShell bundle that exercises exactly the
primitives the Windows PlatformAdapter uses, and reports honestly what
works in the *current session context*. Copy it to a Windows box and run
it — nothing from this repo is needed on the target.

## What it checks

| # | Check | Primitive used |
|---|-------|----------------|
| 1 | Session reality | `whoami /groups` (UAC integrity S-1-16-*), session ids, explorer-in-my-session, `query user`, `qwinsta` |
| 2 | UIA tree | .NET `System.Windows.Automation`, desktop root + top-level windows (depth 1) |
| 2b | Optional notepad probe | `-WithNotepad` starts Notepad, UIA-walks its tree, sends ESC via SendInput, closes it (processes it started itself) |
| 3 | Screen capture | `SetProcessDPIAware()` + `Graphics.CopyFromScreen` -> PNG, then samples ~15k pixels and reports `avgLuma` / `blackRatio` (black-screen honesty check) |
| 4 | SendInput probe | relative move +1px/+1px via `SendInput`, `GetCursorPos` read-back, cursor restored |

## Run it

From the repo root (macOS/Linux dev machine) against a host configured in
`~/.ssh/config` (key auth — never a password):

```bash
# 1. check for an active console session FIRST
ssh -o BatchMode=yes goldagent-151 "query user"
ssh -o BatchMode=yes goldagent-151 "qwinsta"

# 2. transfer the bundle (Windows scp lands relative to the user profile)
ssh -o BatchMode=yes goldagent-151 "powershell -NoProfile -Command New-Item -ItemType Directory -Force -Path C:/Users/gold/win-remote | Out-Null"
scp -o BatchMode=yes scripts/win-remote/probe.ps1 goldagent-151:win-remote/probe.ps1

# 3. run it (add -WithNotepad for the optional app/UIA/SendInput-in-app probe)
ssh -o BatchMode=yes goldagent-151 "powershell -NoProfile -ExecutionPolicy Bypass -File C:\\Users\\gold\\win-remote\\probe.ps1 -WithNotepad"
```

Output: human-readable sections plus a final JSON summary
(`session` / `uia` / `notepad` / `capture` / `input`). Exit code 0 unless
the probe infrastructure itself breaks.

## Reading the results honestly

- **Interactive console session** (`qwinsta` shows a user on `console`,
  `query user` state `Active`): UIA, capture and SendInput are expected to
  work — this is the mode the adapter targets.
- **Disconnected console / SSH-only session**: SSH sessions on Windows run
  in session 0 with no interactive desktop. Expect:
  - UIA: the SSH session sees only its own (session-0) windows; windows of
    the logged-in user's session are usually NOT visible.
  - capture: `CopyFromScreen` may throw or return a valid but **all-black**
    PNG (`blackRatio ≈ 1`) — the probe reports this explicitly.
  - input: `SendInput` may inject into the empty session-0 queue only;
    `GetCursorPos` may not move. Reported as `moved=false` with a note.
  This outcome is a **correct, honest result**, not a probe failure.
- **UAC integrity**: `integrity=Medium` (S-1-16-8192) cannot see or drive
  windows of elevated (`High`, S-1-16-12288) apps; `isAdminGroup=True`
  with `integrity=High` means the probe itself runs elevated.

## Safety

The probe is read-only except: (a) an optional Notepad instance it starts
and closes itself (`-WithNotepad`), and (b) one 1px mouse move that is
restored immediately. It never changes settings, never writes outside its
temp output dir, and never touches user data.


## session1-e2e.ps1 — full primitive closed loop (interactive session)

See docs/install/windows.md → “Interactive-session acceptance”. charmap is
driven: launch → UIA locate → semantic setValue (CJK) → read-back →
SendInput unicode typing → read-back → close. JSON results next to it.

## queue-agent.ps1 + run-hidden.vbs — REMOTE control bridge

The MCP runs on another machine; this agent (hidden, session 1) executes
`capture | input | apps | uia-tree | uia-action | sysinfo` ops from a file
queue. Start:

```bash
ssh <host> "schtasks /create /tn uivenus-bridge /tr "wscript.exe C:\Users\<user>\win-remote\run-hidden.vbs" /sc once /st 23:59 /it /f"
ssh <host> "schtasks /run /tn uivenus-bridge"
```

Driver for the full remote vision-agent E2E (Calculator 7×3, verified
2× SUCCESS on real hardware): `remote-agent-e2e.mjs` from the repo root on
the controlling machine.
