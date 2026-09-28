# Host/system info for honest capability probing (Windows).
#
# Modes (via -Mode):
#   info   -> JSON { psVersion, osVersion, is64Bit, integrity, integrityLabel,
#                    elevated, mySessionId, explorerSessions[], interactiveDesktop,
#                    quser, winStation }
#   procs  -> JSON array of processes with windows: { pid, name, title }
#
# Integrity via `whoami /groups` (S-1-16-xxxx Mandatory Label).
# Interactive-desktop heuristic: an explorer.exe in OUR session id AND
# `query user` reporting an Active session.
#
# Exit codes: 0 ok · 1 unexpected.

param([string]$Mode = "info")

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

function Get-Integrity {
    $sid = ""; $label = "unknown"
    try {
        $groups = whoami.exe /groups 2>$null | Out-String
        $m = [regex]::Match($groups, "S-1-16-(\d+)")
        if ($m.Success) {
            $sid = $m.Value
            switch ($m.Groups[1].Value) {
                "16384" { $label = "System" }
                "12288" { $label = "High" }
                "8192"  { $label = "Medium" }
                "4096"  { $label = "Low" }
                default { $label = "Level $($m.Groups[1].Value)" }
            }
        }
    } catch {}
    return @{ sid = $sid; label = $label; elevated = ($label -in @("High", "System")) }
}

function Get-Quser {
    try {
        $quser = query.exe user 2>$null
        if (-not $quser) { $quser = quser.exe 2>$null }
        if ($quser) { return (@($quser) -join "`n") }
    } catch {}
    return ""
}

try {
    if ($Mode -eq "procs") {
        $out = @()
        foreach ($p in (Get-Process -ErrorAction SilentlyContinue)) {
            if ($p.MainWindowTitle) {
                $t = [string]$p.MainWindowTitle
                if ($t.Length -gt 200) { $t = $t.Substring(0, 200) }
                $out += @{ pid = $p.Id; name = $p.ProcessName; title = $t }
            }
        }
        ConvertTo-Json -InputObject $out -Compress -Depth 4
        exit 0
    }

    $me = Get-Process -Id $PID
    $mySession = $me.SessionId
    $explorerSessions = @()
    foreach ($p in (Get-Process explorer -ErrorAction SilentlyContinue)) {
        $explorerSessions += $p.SessionId
    }
    $interactive = [bool]($explorerSessions -contains $mySession)

    @{
        ok                 = $true
        psVersion          = "$($PSVersionTable.PSVersion)"
        clrVersion         = "$($PSVersionTable.CLRVersion)"
        osVersion          = [System.Environment]::OSVersion.VersionString
        is64Bit            = [bool][System.Environment]::Is64BitOperatingSystem
        integrity          = Get-Integrity
        mySessionId        = $mySession
        explorerSessions   = $explorerSessions
        interactiveDesktop = $interactive
        quser              = Get-Quser
        computerName       = $env:COMPUTERNAME
    } | ConvertTo-Json -Compress -Depth 6
    exit 0
}
catch {
    [Console]::Error.WriteLine("SYSINFO_ERROR: $($_.Exception.Message)")
    exit 1
}
