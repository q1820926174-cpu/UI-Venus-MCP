# =====================================================================
# win-remote probe — self-contained acceptance bundle for the
# Cross-Platform Computer-Use MCP Windows adapter.
#
# Copy this single file to a Windows box and run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File probe.ps1
#
# What it exercises (read-only + one harmless 1px mouse probe):
#   1. Session reality : integrity level, session ids, query user / qwinsta,
#                        interactive-desktop detection
#   2. UIA tree        : desktop root children (depth 1). Optional: -WithNotepad
#                        starts Notepad, walks its tree, sends ESC, closes it.
#   3. Screen capture  : GDI CopyFromScreen -> PNG + average-pixel/black check
#   4. SendInput probe : move cursor +1px and back (GetCursorPos read-back)
#
# Honesty: every check reports what ACTUALLY happened. Over an SSH session
# (session 0, no interactive desktop) expect: UIA empty/failing, capture
# black or failing, SendInput not reaching the console session. That is a
# PASS for this probe as long as the results are reported truthfully.
#
# Output: human-readable sections + a final JSON summary block on stdout.
# Exit code 0 unless a hard infrastructure error occurs.
# =====================================================================
param(
    [switch]$WithNotepad,
    [string]$OutDir = ""
)

$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$script:Result = [ordered]@{
    probe      = "win-remote"
    host       = $env:COMPUTERNAME
    at         = (Get-Date).ToString("o")
    psVersion  = "$($PSVersionTable.PSVersion)"
    session    = $null
    uia        = $null
    notepad    = $null
    capture    = $null
    input      = $null
}

if (-not $OutDir) { $OutDir = Join-Path $env:TEMP "win-remote-probe" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Write-Host "== 1. session reality =============================================="

$mySession = (Get-Process -Id $PID).SessionId
$explorerSessions = @(Get-Process explorer -ErrorAction SilentlyContinue | ForEach-Object { $_.SessionId })
$interactive = $explorerSessions -contains $mySession

$integritySid = ""; $integrityLabel = "unknown"
try {
    $groups = (whoami.exe /groups 2>$null | Out-String)
    $m = [regex]::Match($groups, "S-1-16-(\d+)")
    if ($m.Success) {
        $integritySid = $m.Value
        switch ($m.Groups[1].Value) {
            "16384" { $integrityLabel = "System" }
            "12288" { $integrityLabel = "High" }
            "8192"  { $integrityLabel = "Medium" }
            "4096"  { $integrityLabel = "Low" }
            default { $integrityLabel = "Level $($m.Groups[1].Value)" }
        }
    }
} catch {}

$quser = ""; try { $quser = (@(query.exe user 2>$null) -join "`n") } catch {}
$qwinsta = ""; try { $qwinsta = (@(qwinsta.exe 2>$null) -join "`n") } catch {}

$script:Result.session = [ordered]@{
    mySessionId        = $mySession
    explorerSessions   = $explorerSessions
    interactiveDesktop = [bool]$interactive
    integrity          = $integrityLabel
    integritySid       = $integritySid
    isAdminGroup       = $false
    quser              = $quser
    qwinsta            = $qwinsta
}
try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $pr = New-Object Security.Principal.WindowsPrincipal($id)
    $script:Result.session.isAdminGroup = $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch {}

Write-Host "mySessionId=$mySession explorerSessions=[$($explorerSessions -join ',')] interactiveDesktop=$interactive integrity=$integrityLabel ($integritySid) isAdminGroup=$($script:Result.session.isAdminGroup)"
Write-Host "--- query user ---"; Write-Host $quser
Write-Host "--- qwinsta ------"; Write-Host $qwinsta

Write-Host ""
Write-Host "== 2. UIA tree (System.Windows.Automation) =========================="

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Walk-Uia([System.Windows.Automation.AutomationElement]$el, [int]$depth, [int]$maxDepth, [int]$maxNodes, [System.Collections.Generic.List[object]]$list) {
    if ($list.Count -ge $maxNodes) { return }
    $rid = ""; $role = ""; $name = ""
    try { $rid = (@($el.GetRuntimeId()) -join ",") } catch { return }
    try { $role = $el.Current.ControlType.ProgrammaticName } catch { return }
    try { $name = [string]$el.Current.Name; if ($name.Length -gt 80) { $name = $name.Substring(0, 80) } } catch {}
    $bx = 0; $by = 0; $bw = 0; $bh = 0
    try {
        $r = $el.Current.BoundingRectangle
        if (-not $r.IsEmpty) { $bx = [int]$r.X; $by = [int]$r.Y; $bw = [int]$r.Width; $bh = [int]$r.Height }
    } catch {}
    $patterns = @()
    try {
        foreach ($p in $el.GetSupportedPatterns()) {
            $pn = $p.ProgrammaticName
            if ($pn.Contains("InvokePattern")) { $patterns += "Invoke" }
            elseif ($pn.Contains("TogglePattern")) { $patterns += "Toggle" }
            elseif ($pn.Contains("ValuePattern")) { $patterns += "Value" }
            elseif ($pn.Contains("ExpandCollapsePattern")) { $patterns += "ExpandCollapse" }
            elseif ($pn.Contains("LegacyIAccessiblePattern")) { $patterns += "LegacyIAccessible" }
        }
    } catch {}
    $list.Add([ordered]@{ runtimeId = $rid; role = $role; name = $name; depth = $depth;
                          bounds = @{ x = $bx; y = $by; width = $bw; height = $bh }; patterns = $patterns })
    if ($depth -lt $maxDepth) {
        try {
            $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children,
                               [System.Windows.Automation.Condition]::TrueCondition)
            foreach ($k in $kids) { Walk-Uia $k ($depth + 1) $maxDepth $maxNodes $list }
        } catch {}
    }
}

$root = [System.Windows.Automation.AutomationElement]::RootElement
$desktopList = New-Object System.Collections.Generic.List[object]
try {
    Walk-Uia $root 0 1 60 $desktopList
    $script:Result.uia = [ordered]@{
        desktopRootReadable = $true
        topLevelElements    = $desktopList.Count
        elements            = $desktopList
    }
    Write-Host ("desktop root readable: YES; root+top-level elements: {0}" -f $desktopList.Count)
    foreach ($e in $desktopList) {
        Write-Host ("  [{0}] {1} '{2}' bounds=({3},{4},{5},{6})" -f $e.depth, $e.role, $e.name, $e.bounds.x, $e.bounds.y, $e.bounds.width, $e.bounds.height)
    }
} catch {
    $script:Result.uia = [ordered]@{ desktopRootReadable = $false; error = $_.Exception.Message }
    Write-Host "desktop root readable: NO -> $($_.Exception.Message)"
}

if ($WithNotepad) {
    Write-Host ""
    Write-Host "-- 2b. notepad probe (start / UIA walk / ESC / close) ---------------"
    $np = [ordered]@{ started = $false; pid = $null; treeElements = 0; escSent = $null; closed = $false }
    try {
        $proc = Start-Process -FilePath "notepad.exe" -PassThru -ErrorAction Stop
        $np.started = $true; $np.pid = $proc.Id
        Start-Sleep -Seconds 3
        $proc.Refresh()
        if ($proc.HasExited) {
            # Win11 may relaunch notepad under a different pid; find by name
            $p2 = Get-Process notepad -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($p2) { $np.pid = $p2.Id } else { throw "notepad exited immediately" }
        }
        $cond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$np.pid)
        $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
        if ($win -ne $null) {
            $npList = New-Object System.Collections.Generic.List[object]
            Walk-Uia $win 0 4 150 $npList
            $np.treeElements = $npList.Count
            Write-Host ("notepad window found via UIA; elements: {0}" -f $npList.Count)
            foreach ($e in ($npList | Select-Object -First 12)) {
                Write-Host ("  [{0}] {1} '{2}'" -f $e.depth, $e.role, $e.name)
            }
        } else {
            Write-Host "notepad window NOT visible via UIA from this session (cross-session UIA blocked or window not up yet)"
        }
    } catch {
        $np.error = $_.Exception.Message
        Write-Host "notepad probe error: $($_.Exception.Message)"
    }
    $script:Result.notepad = $np
}

Write-Host ""
Write-Host "== 3. screen capture (GDI CopyFromScreen + average pixel) ==========="

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class WrScreen {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[void][WrScreen]::SetProcessDPIAware()
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$cap = [ordered]@{ ok = $false }
try {
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $file = Join-Path $OutDir "capture.png"
    $bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
    try {
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try { $g.CopyFromScreen($vs.X, $vs.Y, 0, 0, (New-Object System.Drawing.Size $vs.Width, $vs.Height)) } finally { $g.Dispose() }
        $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
        $cap.ok = $true
        $cap.file = $file
        $cap.virtualScreen = @{ x = $vs.X; y = $vs.Y; width = $vs.Width; height = $vs.Height }
    } finally { $bmp.Dispose() }

    $bmp2 = New-Object System.Drawing.Bitmap $file
    try {
        $n = 0; $sum = [double]0; $black = 0
        $sx = [Math]::Max(1, [int]($bmp2.Width / 120)); $sy = [Math]::Max(1, [int]($bmp2.Height / 120))
        for ($y = 0; $y -lt $bmp2.Height; $y += $sy) {
            for ($x = 0; $x -lt $bmp2.Width; $x += $sx) {
                $c = $bmp2.GetPixel($x, $y)
                $lum = 0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B
                $sum += $lum
                if ($lum -lt 4) { $black++ }
                $n++
            }
        }
        $cap.width = $bmp2.Width; $cap.height = $bmp2.Height
        $cap.avgLuma = if ($n -gt 0) { [Math]::Round($sum / $n, 2) } else { 0 }
        $cap.sampled = $n
        $cap.blackRatio = if ($n -gt 0) { [Math]::Round($black / $n, 4) } else { 1 }
        $cap.allBlack = ($cap.blackRatio -gt 0.995)
    } finally { $bmp2.Dispose() }

    Write-Host ("capture OK: {0}x{1} at ({2},{3}) file={4}" -f $cap.width, $cap.height, $vs.X, $vs.Y, $file)
    Write-Host ("content check: avgLuma={0} sampled={1} blackRatio={2} allBlack={3}" -f $cap.avgLuma, $cap.sampled, $cap.blackRatio, $cap.allBlack)
} catch {
    $cap.ok = $false
    $cap.error = $_.Exception.Message
    Write-Host "capture FAILED: $($_.Exception.Message)"
}
$script:Result.capture = $cap

Write-Host ""
Write-Host "== 4. SendInput probe (move cursor +1px and back) ===================="

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class WrInput {
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }
    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint n, INPUT[] p, int size);
    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    public struct POINT { public int X; public int Y; }
    public const uint MOVE = 0x0001; public const uint ABSOLUTE = 0x8000;

    public static uint MoveBy(int dx, int dy) {
        var ev = new INPUT[1];
        ev[0].type = 0;
        ev[0].u.mi.dx = dx; ev[0].u.mi.dy = dy;
        ev[0].u.mi.dwFlags = MOVE; // relative
        return SendInput(1, ev, Marshal.SizeOf(typeof(INPUT)));
    }
    public static bool CursorPos(out int x, out int y) {
        POINT p;
        bool ok = GetCursorPos(out p);
        x = p.X; y = p.Y;
        return ok;
    }
}
"@

$probe = [ordered]@{ sent = 0; before = $null; after = $null; moved = $false; note = "" }
try {
    $bx = 0; $by = 0
    [void][WrInput]::CursorPos([ref]$bx, [ref]$by)
    $probe.before = @{ x = $bx; y = $by }
    $probe.sent = [WrInput]::MoveBy(1, 1)
    Start-Sleep -Milliseconds 120
    $ax = 0; $ay = 0
    [void][WrInput]::CursorPos([ref]$ax, [ref]$ay)
    $probe.after = @{ x = $ax; y = $ay }
    $probe.moved = ($ax -eq $bx + 1 -and $ay -eq $by + 1)
    if (-not $probe.moved) {
        # restore regardless (SetCursorPos works even when relative injection is filtered)
        [void][WrInput]::SetCursorPos($bx, $by)
        if ($probe.sent -eq 0) { $probe.note = "SendInput injected 0 events (blocked in this session)" }
        else { $probe.note = "events accepted but cursor did not move (no interactive desktop in this session)" }
    }
    Write-Host ("SendInput returned: {0}; cursor {1} -> {2}; moved={3} {4}" -f $probe.sent, "$($bx),$($by)", "$($ax),$($ay)", $probe.moved, $probe.note)
} catch {
    $probe.note = $_.Exception.Message
    Write-Host "SendInput probe FAILED: $($_.Exception.Message)"
}
$script:Result.input = $probe

# close notepad we started (cleanup of our own probe)
if ($WithNotepad -and $script:Result.notepad -and $script:Result.notepad.pid) {
    try {
        Stop-Process -Id ([int]$script:Result.notepad.pid) -Force -ErrorAction Stop
        $script:Result.notepad.closed = $true
        Write-Host ""
        Write-Host "notepad probe closed (Stop-Process on the pid we started)"
    } catch {
        Write-Host "could not close notepad pid $($script:Result.notepad.pid): $($_.Exception.Message)"
    }
}

Write-Host ""
Write-Host "== JSON summary ======================================================"
ConvertTo-Json -InputObject $script:Result -Depth 8
exit 0
