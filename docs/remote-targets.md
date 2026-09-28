# Remote Targets — the primary deployment model

This MCP's main job is **not** controlling the machine it runs on. Most
real targets are remote boxes with awkward access: SSH-only intranet
hosts, no internet, locked-down sessions, no permission to install
anything. The controlling machine runs the full MCP stack (orchestrator,
UI-Venus provider, verifier); the target runs **only inbox tooling**
(Windows PowerShell bridges; Linux tools documented per adapter).

```text
Controller (macOS/Linux/Windows)          Remote target ("奇葩环境")
─────────────────────────────             ─────────────────────────────
TaskOrchestrator + UI-Venus               queue-agent.ps1 (session 1,
        │                                  hidden, inbox PowerShell)
        │  ssh: drop queue/<id>.cmd.json ─▶ executes capture/input/UIA
        │  poll results/<id>.json       ◀─ writes JSON results
        │  scp: fetch captured PNG      ◀─
        ▼
vision decides next action → repeat until Finished + verified
```

## Onboarding a new Windows host — one command

```bash
node scripts/win-remote/bootstrap-remote.mjs <ssh-alias> [remoteRoot]
```

Automates everything this repo learned the hard way on a real Windows 11
intranet host (verified 2026-09-29, twice):

1. SSH key-auth check + session reality (`query user`)
2. Transfer the bridges (`screen/input/apps/sysinfo/uia-*.ps1` +
   `queue-agent.ps1` + hidden launcher) — nothing else lands on the host
3. Activate a disconnected console session (`tscon 1 /dest:console`)
4. (Re)install the hidden session-1 queue agent via `schtasks /IT` +
   wscript; retire stale agents first
5. Verify end-to-end: bridge ping → real screen capture → PNG magic check

Then register the target on the controller (one env var, any number of
hosts):

```bash
export CUMCP_REMOTES='[
  { "name": "win-151", "platform": "windows", "kind": "ssh-queue",
    "sshHost": "goldagent-151", "root": "C:\\Users\\gold\\win-remote" },
  { "name": "win-lab2", "platform": "windows", "kind": "ssh-queue",
    "sshHost": "lab2", "root": "C:\\lab\\win-remote" }
]'
node dist/index.js
```

Agents address targets by name or ssh alias:

```json
{ "target": { "type": "remote", "platform": "windows", "host": "win-151" } }
```

`computer_list_targets` probes every configured remote and reports each
one's reachability honestly.

Single-target shorthand (still supported):
`CUMCP_REMOTE_WINDOWS_SSH` + `CUMCP_REMOTE_WINDOWS_ROOT`.

## The environment quirks this stack absorbs (learned on real hardware)

| Quirk | Consequence | How the stack handles it |
|---|---|---|
| SSH lands in **session 0** (no desktop) | `CopyFromScreen` → "handle is invalid"; `SendInput` → `Win32Error=5`; GUI apps die instantly | queue agent runs in the interactive session via `schtasks /IT` |
| Console host shows a window | Windows Terminal ignores `-WindowStyle Hidden`; the bridge's own console covers the apps you automate | wscript launcher with window style 0 (`run-hidden.vbs`) |
| Session exists but **disconnected** (`Disc`) | same session-0 symptoms even for the task | `tscon 1 /dest:console` (bootstrap does it) |
| No internet on the target | vision endpoint unreachable from there | the provider runs on the controller; target never talks to the model |
| Packaged apps (Win11 Notepad/Calculator) | launcher pid owns no window (`MainWindowHandle=0`) | pid-scoped UIA falls back to `windowTitle` scope; vision clicks unaffected |
| Target window loses foreground | injected input silently dropped | `SetForegroundWindow(WindowFromPoint)` before every click (`input.ps1`) |
| PS 5.1 codepage mojibake | CJK names/values garbled | base64 payloads both ways; `Get-Content -Encoding UTF8`; BOM in every `.ps1` |
| RuntimeIds unstable across processes | semantic actions can't re-find elements | signature fallback (pid+role+name+autoId+bounds), `matchedBy` reported |
| 9B click imprecision (±30px) | misses 48px buttons | §21 fusion: vision point → UIA element → bounds-center semantic click |
| Tiny text changes invisible to pixel hashes | false "screen unchanged" → premature stagnation | stagnation guard prefers a UIA tree-state digest |

## Verified outcome on the reference host

Host: Windows 11 Pro build 26200, intranet, SSH-only, no internet.
Full vision-driven delegate task (official UI-Venus Computer protocol):

> 使用计算器计算 7 乘以 3 → model autonomously: 清除 → 7 → 乘以 → 3 → 等于
> → display **21** → vision verifier: "displays the expression 7 × 3 =
> and the result 21" — **SUCCESS, twice consecutively.**

Reproduce: `node scripts/win-remote/remote-agent-e2e.mjs` (uses `.env`
for VENUS_* + the configured remote).

## Connector interface (adding new transports)

Everything above the transport is connector-agnostic
([src/remote/types.ts](../src/remote/types.ts)):

```ts
interface RemoteConnector {
  command(op, extra?, timeoutMs?): Promise<BridgeResult>;
  fetchBinary(remotePath, localPath): Promise<void>;
  ping(timeoutMs?): Promise<void>;
}
```

`SshQueueConnector` is the reference implementation. RDP/VNC/SPICE or
agent-side bridges plug in by implementing this interface and adding a
`kind` in [src/remote/registry.ts](../src/remote/registry.ts); the
adapters, orchestrator and tools need no changes.
