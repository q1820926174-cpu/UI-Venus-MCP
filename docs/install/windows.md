# Windows setup — Cross-Platform Computer-Use MCP

## Requirements

| Component | Requirement | Notes |
|---|---|---|
| OS | Windows 10 1809+ / Windows 11 | tested on Windows 11 Pro, build 26200 (2026-09) |
| Node.js | >= 20 | `winget install OpenJS.NodeJS.LTS` or your standard channel |
| PowerShell | Windows PowerShell 5.1 | built into Windows (`powershell.exe`); no PowerShell 7 needed |
| Python | not needed | native bridges are .ps1 driven via .NET (`System.Windows.Automation`, `System.Drawing`) |
| Extra runtime deps | none | everything is Inbox Windows |

## Install

```powershell
git clone <repo> ui-venus-mcp
cd ui-venus-mcp
npm install
npm run build          # tsc -> dist/
```

## Run the MCP server

```powershell
node dist\index.js                     # stdio MCP server
node dist\index.js --http --port 8765  # HTTP mode
```

Targets: `{ "type": "local", "platform": "windows" }` (or `platform: "auto"`
on a Windows host). The adapter registers itself via
`createWindowsRegistration()` (`src/platforms/windows/adapter.ts`).

Environment overrides:

- `UIVENUS_WINDOWS_SCRIPTS` — directory holding the .ps1 bridges (default:
  auto-detected next to the compiled module, or `src/platforms/windows/scripts`).
- `UIVENUS_POWERSHELL` — PowerShell executable (default `powershell.exe`).

## Coordinate space (important)

Everything on Windows is **physical screen pixels**: UIA `BoundingRectangle`,
GDI screenshots (taken in a `SetProcessDPIAware()` session) and `SendInput`
all agree. `Screenshot.scale = 1`, `origin` = virtual-screen origin
(negative on multi-monitor with left-placed displays). `DisplayInfo.scale`
is the OS DPI scale (`GetDpiForSystem`) and is informational only.

## Permissions reality

- **UIA (accessibility tree / semantic actions)**: a process can only see
  UI at its OWN integrity level or lower. `whoami /groups` shows the
  mandatory label: Medium = `S-1-16-8192`, High (elevated/admin) =
  `S-1-16-12288`. **Apps started with "Run as administrator" are NOT
  automatable from a non-elevated MCP process** — UIA sees nothing and UIPI
  blocks input injection. Run the MCP elevated if you need to drive
  elevated apps.
- **Screen capture** works **per session**: `CopyFromScreen` captures the
  desktop of the *calling* session only. There is no separate
  screen-recording permission dialog on Windows, but a session without a
  desktop (SSH, services, session 0) cannot capture at all, and a
  locked/disconnected session yields a valid but **all-black** PNG. The
  adapter reports capture stats (average luma / black ratio) so callers can
  distinguish "real screen" from "black frame" honestly.
- **SendInput** injects into the calling session's input queue only, and is
  blocked by UIPI for higher-integrity windows.
- The capability probe (`open()`) reports all of this in
  `Capabilities.notes`; the JSON-RPC `list_targets` probe surfaces
  integrity level and interactive-desktop detection.

## Acceptance: `scripts/win-remote/`

- `probe.ps1` — self-contained single-file probe: session reality, UIA tree,
  capture (black-frame check), 1px SendInput probe, optional `-WithNotepad`.
- `session1-e2e.ps1` — **the full closed loop** in the interactive session
  (see the next section): capture → input → UIA semantic write → read-back
  verification → unicode typing → clean close, results as JSON.

See `scripts/win-remote/README.md` for the procedure. Quick probe version:

```bash
ssh <host> "query user"                                  # check console session first
ssh <host> "powershell -NoProfile -Command New-Item -ItemType Directory -Force -Path C:/Users/<user>/win-remote | Out-Null"
scp scripts/win-remote/probe.ps1 <host>:win-remote/probe.ps1
ssh <host> "powershell -NoProfile -ExecutionPolicy Bypass -File C:\\Users\\<user>\\win-remote\\probe.ps1 -WithNotepad"
```

## SSH access to the test host (`goldagent-151`)

Key-based auth only — never passwords:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/goldagent_151      # once
ssh-copy-id -i ~/.ssh/goldagent_151.pub goldagent-151   # or have the owner install the .pub
```

`~/.ssh/config`:

```
Host goldagent-151
    HostName 10.251.151.2
    User gold
    IdentityFile ~/.ssh/goldagent_151
    IdentitiesOnly yes
```

## Interactive-session acceptance (REAL E2E, Windows 11 Pro build 26200,
## host DESKTOP-N8HLVGG, user "gold", 2026-09-28)

**Full closed loop verified in the interactive session.** SSH runs in
session 0 (no desktop); two techniques unlock real-desktop testing:

1. **Activate the logged-on session on the physical console** (it is often
   `Disc` = disconnected, which also blocks capture/input):

   ```bash
   ssh goldagent-151 "tscon 1 /dest:console"     # session 1 → Active on console
   ssh goldagent-151 "query user"                # verify 状态=运行中/Active
   ```

2. **Run the harness inside session 1** via an interactive scheduled task
   (SSH-launched GUI apps land in session 0 and die instantly):

   ```bash
   scp scripts/win-remote/session1-e2e.ps1 goldagent-151:win-remote/
   scp src/platforms/windows/scripts/*.ps1 goldagent-151:win-remote/scripts/
   ssh goldagent-151 "schtasks /create /tn uivenus-e2e /tr \"powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\gold\win-remote\session1-e2e.ps1\" /sc once /st 23:59 /it /f"
   ssh goldagent-151 "schtasks /run /tn uivenus-e2e"
   # poll + fetch the JSON result:
   ssh goldagent-151 "type C:\Users\gold\win-remote\session1-e2e-result.json"
   ```

### Results (session 1, Active — `session1-e2e.ps1`, 2026-09-28 23:26)

| Primitive | Result | Verdict |
|---|---|---|
| session context | `sessionId=1`, `interactive=true`, user `desktop-n8hlvgg\gold` | ✅ runs in session 1 |
| Display metrics | 1920×1080 `\\.\DISPLAY1`, DPI 96, foreground window detected | ✅ |
| GDI capture | 1920×1080 PNG, 189.6 KB, `blackRatio=0` → `REAL_IMAGE` | ✅ |
| SendInput move | `ok:true`, cursor read-back `(960,540)` | ✅ |
| SendInput key (esc) | `ok:true` | ✅ |
| UIA tree (charmap pid) | 14 elements; window `字符映射表`; Edit `复制字符(A):` rid `42,329396` | ✅ |
| UIA `setValue` (semantic write, CJK) | `ok:true, matchedBy:runtimeId`, value written verbatim, no mojibake | ✅ |
| UIA `readState` read-back | contains expected string | ✅ |
| SendInput unicode type (CJK) | 14 units injected; appended text verified via read-back | ✅ |
| Clean close | charmap closed via `CloseMainWindow` | ✅ |

### Session 0 (SSH) vs Session 1 (interactive) — honest matrix

| Primitive | Session 0 (SSH/service) | Session 1 (Active console/RDP) |
|---|---|---|
| sysinfo / display metrics / process control | works | works |
| UIA tree | own (empty) session desktop only | ✅ real windows & elements |
| GDI capture | `The handle is invalid` | ✅ real image |
| SendInput | `Win32Error=5` denied | ✅ injected + verified |
| GUI app launch | process exits immediately | ✅ stays alive |

### Caveats found by real testing

- **Win11 Notepad is a packaged app**: the started pid keeps
  `MainWindowHandle=0` (the window is not owned by the launcher process),
  so pid-scoped UIA cannot enumerate it. Use classic Win32 apps
  (`charmap`, `mspaint`, …) for acceptance loops; Notepad automation needs
  window-title/desktop-root scoping instead of pid scoping.
- **PowerShell 5.1 needs UTF-8 BOM** in `.ps1` files or CJK constants get
  read as GBK (mojibake). All repo scripts ship with a BOM.
- **RuntimeIds are not stable across processes**; the adapter's signature
  fallback (pid+role+name+autoId+bounds) matches reliably
  (`matchedBy: "signature"`).
- Single-line EDIT controls report a trailing `\r`; `setValue`
  verification compares trimmed values.

## Troubleshooting

- **`powershell.exe not found` / script dir not found** — set
  `UIVENUS_WINDOWS_SCRIPTS` and `UIVENUS_POWERSHELL` explicitly.
- **UIA returns an empty tree** — the app may be elevated (UAC), or it is
  in another session. Check `Capabilities.notes` from `open()`.
- **Actions return `restricted` with "injected 0 events"** — you are not
  in an interactive session, or the target window has higher integrity.
- **All-black screenshots** — the session is locked/disconnected; compare
  `Screenshot.hash` over time or check the capture stats.
