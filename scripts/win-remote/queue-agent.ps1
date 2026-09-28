# queue-agent.ps1 — session-1 execution bridge for REMOTE MCP control.
#
# The MCP server runs on another machine (e.g. macOS) and drives this
# Windows host over SSH. SSH commands land in session 0 where capture and
# SendInput are blocked, so this agent — started ONCE in the interactive
# session via:
#
#   schtasks /create /tn uivenus-bridge /tr "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\gold\win-remote\queue-agent.ps1" /sc once /st 23:59 /it /f
#   schtasks /run /tn uivenus-bridge
#
# — polls <root>\queue\*.cmd.json, executes each command through the
# sibling adapter scripts (screen/input/apps/uia), and writes
# <root>\results\<id>.json. The remote side just drops files and polls:
# no agents, no installs, inbox PowerShell only.
#
# Commands (JSON): { id, op, ... }
#   { op: "ping" }
#   { op: "capture", out: "<file>.png" }                       → screen.ps1
#   { op: "input", mode, args: {...} }                          → input.ps1
#   { op: "apps", mode, args: {...} }                           → apps.ps1
#   { op: "uia-tree", args: {...} }                             → uia-tree.ps1
#   { op: "uia-action", args: {...} }                           → uia-action.ps1
#   { op: "sysinfo" }                                           → sysinfo.ps1
#   { op: "stop" }                                              → agent exits
#
# Results: { id, ok, exit, json|null, stdout, stderr, at }

param(
    [string]$Root = $PSScriptRoot,
    [int]$PollMs = 120
)
$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$Queue = Join-Path $Root "queue"
$Results = Join-Path $Root "results"
$S = Join-Path $Root "scripts"
New-Item -ItemType Directory -Force -Path $Queue, $Results | Out-Null

function Write-Result {
    param([object]$Cmd, [bool]$Ok, [int]$Exit, [string]$Json, [string]$Stdout, [string]$Stderr)
    $r = [ordered]@{
        id     = $Cmd.id
        ok     = $Ok
        exit   = $Exit
        json   = $null
        stdout = ($Stdout | Out-String).Trim()
        stderr = ($Stderr | Out-String).Trim()
        at     = (Get-Date).ToString("o")
    }
    if ($Json) { try { $r.json = $Json | ConvertFrom-Json } catch {} }
    $r | ConvertTo-Json -Depth 8 | Out-File -Encoding utf8 (Join-Path $Results "$($Cmd.id).json")
}

# markers so the remote side can see liveness
@{ startedAt = (Get-Date).ToString("o"); session = [Environment]::UserInteractive; pid = $PID } |
    ConvertTo-Json | Out-File -Encoding utf8 (Join-Path $Results "bridge.json")

while ($true) {
    $cmds = Get-ChildItem $Queue -Filter *.cmd.json -ErrorAction SilentlyContinue | Sort-Object LastWriteTime
    foreach ($f in $cmds) {
        try { $cmd = Get-Content $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch {
            Move-Item $f.FullName (Join-Path $Queue "$($f.Name).bad") -Force
            continue
        }
        # claim it before executing (atomic-ish: rename then process)
        $claimed = Join-Path $Queue "$($cmd.id).doing"
        try { Rename-Item $f.FullName "$($cmd.id).doing" -ErrorAction Stop } catch { continue }

        if ($cmd.op -eq "stop") {
            Write-Result $cmd $true 0 '{"stopped":true}' "" ""
            Remove-Item $claimed -Force -ErrorAction SilentlyContinue
            break
        }
        if ($cmd.op -eq "ping") {
            Write-Result $cmd $true 0 ('{"pong":true,"session":' + [Environment]::UserInteractive + '}') "" ""
            Remove-Item $claimed -Force -ErrorAction SilentlyContinue
            continue
        }

        $script = $null; $mode = ""; $argsJson = ""; $outFile = ""
        switch ($cmd.op) {
            "capture"    { $script = "screen.ps1"; $mode = "capture"; $outFile = [string]$cmd.out }
            "sysinfo"    { $script = "screen.ps1"; $mode = "info" }
            "input"      { $script = "input.ps1";  $mode = [string]$cmd.mode }
            "apps"       { $script = "apps.ps1";   $mode = [string]$cmd.mode }
            "uia-tree"   { $script = "uia-tree.ps1" }
            "uia-action" { $script = "uia-action.ps1" }
            default      { $script = $null }
        }
        if (-not $script) {
            Write-Result $cmd $false 1 $null "" "unknown op: $($cmd.op)"
            Remove-Item $claimed -Force -ErrorAction SilentlyContinue
            continue
        }
        if ($cmd.args) {
            $argsJson = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($cmd.args | ConvertTo-Json -Compress -Depth 6)))
        }
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = "powershell"
        $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$($S)\$script`"" +
            $(if ($mode) { " -Mode $mode" }) +
            $(if ($argsJson) { " -ArgsJson $argsJson" }) +
            $(if ($outFile) { " -OutFile `"$outFile`"" })
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.UseShellExecute = $false
        $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
        $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
        $proc = [System.Diagnostics.Process]::Start($psi)
        $stdout = $proc.StandardOutput.ReadToEnd()
        $stderr = $proc.StandardError.ReadToEnd()
        $proc.WaitForExit()
        $ok = ($proc.ExitCode -eq 0)
        # capture op: report the PNG too
        $jsonPayload = $null
        if ($cmd.op -eq "capture" -and $ok) {
            $jsonPayload = $stdout
        } else { $jsonPayload = $stdout }
        Write-Result $cmd $ok $proc.ExitCode $jsonPayload $stdout $stderr
        Remove-Item $claimed -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds $PollMs
}
