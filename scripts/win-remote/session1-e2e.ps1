# session1-e2e.ps1 — FULL Windows adapter primitive E2E, meant to run in the
# INTERACTIVE session (session 1) via:
#   schtasks /create /tn uivenus-e2e /tr "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\gold\win-remote\session1-e2e.ps1" /sc once /st 23:59 /it /f
#   schtasks /run /tn uivenus-e2e
# (SSH/service sessions are session 0: no interactive desktop — capture and
#  SendInput are blocked there. This script proves the REAL paths.)
#
# Harmless by design: only Notepad is driven, with our own text.
# Results: JSON written to session1-e2e-result.json next to this file.

param(
    [string]$Root = $PSScriptRoot,
    [string]$OutFile = ""
)
$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
if (-not $OutFile) { $OutFile = Join-Path $Root "session1-e2e-result.json" }
$S = Join-Path $Root "scripts"
$results = [ordered]@{ startedAt = (Get-Date).ToString("o") }

function Invoke-Step {
    param([string]$Name, [scriptblock]$Body)
    try {
        $value = & $Body
        $script:results[$Name] = if ($null -ne $value) { $value } else { "ok" }
    } catch {
        $script:results[$Name] = "ERROR: $($_.Exception.Message)"
    }
}

# Extract the LAST JSON object line from noisy powershell output.
function Get-JsonFromOutput {
    param([string]$Text)
    $matches2 = [regex]::Matches($Text, '\{[\s\S]*?\}(?=\s*$|[\r\n])')
    if ($matches2.Count -gt 0) {
        try { return ($matches2[$matches2.Count - 1].Value | ConvertFrom-Json) } catch { return $null }
    }
    return $null
}

# --- 0. session reality -----------------------------------------------------
Invoke-Step "session" {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
    $session = (Get-Process -Id $PID).SessionId
    @{
        whoami       = whoami
        sessionId    = $session
        interactive  = [Environment]::UserInteractive
        isSessionOne = ($session -eq 1)
    }
}

# --- 1. screen info ----------------------------------------------------------
Invoke-Step "screenInfo" {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $S "screen.ps1") -Mode info | ConvertFrom-Json
}

# --- 2. capture (the session-0 blocker — must work here) --------------------
$shotPath = Join-Path $Root "session1-shot.png"
Invoke-Step "capture" {
    $json = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $S "screen.ps1") -Mode capture -OutFile $shotPath 2>&1 | Out-String
    try { $o = $json | ConvertFrom-Json } catch { return "unparseable: $json" }
    @{
        ok         = $o.ok
        width      = $o.width
        height     = $o.height
        avgR       = [math]::Round($o.avgR, 1)
        blackRatio = [math]::Round($o.blackRatio, 4)
        fileKB     = if (Test-Path $shotPath) { [math]::Round((Get-Item $shotPath).Length / 1KB, 1) } else { 0 }
        verdict    = if ($o.ok -and $o.blackRatio -lt 0.95) { "REAL_IMAGE" } else { "BLACK_OR_FAILED" }
    }
}

# --- 3. SendInput probes ------------------------------------------------------
Invoke-Step "sendInputMove" {
    $info = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $S "screen.ps1") -Mode info | ConvertFrom-Json
    $cx = [int]($info.virtualScreen.x + $info.virtualScreen.width / 2)
    $cy = [int]($info.virtualScreen.y + $info.virtualScreen.height / 2)
    $payload = @{ x = $cx; y = $cy } | ConvertTo-Json -Compress
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
    $json = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $S "input.ps1") -Mode move -ArgsJson $b64 2>&1 | Out-String
    $o = Get-JsonFromOutput $json
    if ($o) { @{ injected = $o.ok; cursor = "$($o.cursor.x),$($o.cursor.y)"; verdict = if ($o.ok) { "MOVED" } else { "BLOCKED" } } } else { "unparseable: $json" }
}
Invoke-Step "sendInputKey" {
    $payload = @{ key = "esc" } | ConvertTo-Json -Compress
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
    $json = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $S "input.ps1") -Mode key -ArgsJson $b64 2>&1 | Out-String
    $o = Get-JsonFromOutput $json
    if ($o) { @{ ok = $o.ok; verdict = if ($o.ok) { "INJECTED" } else { "BLOCKED" } } } else { "unparseable: $json" }
}

# --- 4. Classic Win32 app closed loop: charmap → UIA locate → setValue → readback
# (Win11 Notepad is a packaged app whose window is NOT owned by the launcher
#  pid — MainWindowHandle stays 0 — so pid-scoped UIA cannot find it. charmap
#  is a classic Win32 dialog with a real EDIT control.)
Stop-Process -Name notepad -Force -ErrorAction SilentlyContinue
$appPid = 0
Invoke-Step "appLaunch" {
    $p = Start-Process charmap -PassThru
    $script:appPid = $p.Id
    Start-Sleep -Seconds 4
    @{ pid = $p.Id; alive = -not $p.HasExited; title = $p.MainWindowTitle }
}

Invoke-Step "uiaTree" {
    if (-not $appPid -or $appPid -eq 0) { return "skipped: no app" }
    $payload = @{ pid = $appPid } | ConvertTo-Json -Compress
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
    $json = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $S "uia-tree.ps1") -ArgsJson $b64 2>&1 | Out-String
    if ($json -match "PROCESS_NOT_FOUND") {
        Start-Sleep -Seconds 3
        $json = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $S "uia-tree.ps1") -ArgsJson $b64 2>&1 | Out-String
    }
    try {
        $els = $json | ConvertFrom-Json
        $edit = $els | Where-Object { $_.role -in @("ControlType.Edit", "ControlType.Document") } | Select-Object -First 1
        if (-not $edit) { $edit = $els | Where-Object { "$($_.patterns)" -like "*Value*" } | Select-Object -First 1 }
        $script:notepadEditRid = $edit.runtimeId
        @{
            elements   = @($els).Count
            editRid    = $edit.runtimeId
            editName   = $edit.name
            windowName = ($els | Where-Object { $_.role -eq "ControlType.Window" } | Select-Object -First 1).name
        }
    } catch { "unparseable: $($json.Substring(0, [Math]::Min(200, $json.Length)))" }
}

Invoke-Step "uiaSetValue" {
    if (-not $script:notepadEditRid) { return "skipped: no edit element" }
    $payload = @{ pid = $appPid; runtimeId = $script:notepadEditRid; action = "setValue"; value = "UIVENUS-E2E-semantic-写入测试-123" } | ConvertTo-Json -Compress
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
    $json = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $S "uia-action.ps1") -ArgsJson $b64 2>&1 | Out-String
    try { $json | ConvertFrom-Json } catch { "unparseable: $json" }
}

Invoke-Step "uiaReadBack" {
    if (-not $script:notepadEditRid) { return "skipped" }
    $payload = @{ pid = $appPid; runtimeId = $script:notepadEditRid; action = "readState" } | ConvertTo-Json -Compress
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
    $json = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $S "uia-action.ps1") -ArgsJson $b64 2>&1 | Out-String
    $o = Get-JsonFromOutput $json
    if ($o) { @{ value = $o.value; containsExpected = ("$($o.value)" -like "*UIVENUS-E2E-semantic-写入测试-123*") } } else { "unparseable: $json" }
}

Invoke-Step "sendInputType" {
    # focus the edit, then SendInput unicode typing (CJK included)
    if (-not $script:notepadEditRid) { return "skipped" }
    $focusPayload = @{ pid = $appPid; runtimeId = $script:notepadEditRid; action = "setFocus" } | ConvertTo-Json -Compress
    $fb64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($focusPayload))
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $S "uia-action.ps1") -ArgsJson $fb64 | Out-Null
    Start-Sleep -Milliseconds 300
    $typePayload = @{ text = "`r+发送输入-ABC-789" } | ConvertTo-Json -Compress
    $tb64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($typePayload))
    $json = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $S "input.ps1") -Mode type -ArgsJson $tb64 2>&1 | Out-String
    $o = Get-JsonFromOutput $json
    if ($o) { $o } else { "unparseable: $json" }
}

Invoke-Step "finalReadBack" {
    if (-not $script:notepadEditRid) { return "skipped" }
    $payload = @{ pid = $appPid; runtimeId = $script:notepadEditRid; action = "readState" } | ConvertTo-Json -Compress
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
    $json = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $S "uia-action.ps1") -ArgsJson $b64 2>&1 | Out-String
    $o = Get-JsonFromOutput $json
    if ($o) { @{ value = $o.value; typedAppended = ("$($o.value)" -like "*发送输入-ABC-789*") } } else { "unparseable: $json" }
}

Invoke-Step "appClose" {
    if ($appPid -and $appPid -gt 0) {
        $p = Get-Process -Id $appPid -ErrorAction SilentlyContinue
        if ($p) { $p.CloseMainWindow() | Out-Null; Start-Sleep -Milliseconds 500; Stop-Process -Id $appPid -Force -ErrorAction SilentlyContinue }
        "closed"
    } else { "skipped" }
}
Stop-Process -Name notepad, charmap -Force -ErrorAction SilentlyContinue

$results.finishedAt = (Get-Date).ToString("o")
$results | ConvertTo-Json -Depth 8 | Out-File -Encoding utf8 $OutFile
Write-Output "DONE -> $OutFile"
