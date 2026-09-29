# UIA semantic action by RuntimeId — invoke/toggle/setValue/select/focus/readState.
# Re-walks the same scope used by uia-tree.ps1 and matches the joined RuntimeId,
# because UIA offers no "find by runtime id" API.
#
# ArgsJson (base64 UTF-8 JSON):
#   runtimeId  [string] required, e.g. "42,123456,7"
#   action     [string] invoke | toggle | setValue | select | expand | collapse |
#                       setFocus | readState | readBounds   (default readState)
#   value      [string] for setValue
#   pid / processName / windowTitle / desktopRoot — scope (same as uia-tree.ps1)
#   toggleValue       [bool?]  desired toggle state (skip if already there)
#   expectedValue     [string] for setValue verification tolerance
#
# stdout on success: compact JSON { ok, runtimeId, ...verification fields }
# Exit codes: 0 ok · 3 ELEMENT_NOT_FOUND · 4 PATTERN_NOT_SUPPORTED ·
#             5 ACTION_FAILED · 6 VERIFY_FAILED · 1 unexpected.

param(
    [string]$ArgsJson = "",
    [int]$MaxDepth = 14,
    [int]$MaxNodes = 4000
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

if ($ArgsJson -and -not $ArgsJson.StartsWith("{")) {
    $ArgsJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($ArgsJson))
}
$opts = ConvertFrom-Json $ArgsJson

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$wantRid = [string]$opts.runtimeId
$action = [string]$opts.action
if (-not $action) { $action = "readState" }
if (-not $wantRid -and $action -ne "foreground") {
    [Console]::Error.WriteLine("UIA_ERROR: runtimeId is required")
    exit 5
}
# Optional element signature for matching when the RuntimeId is not stable
# across client processes (observed for non-hwnd bridged elements such as
# the desktop root): { pid, role, name, autoId, className, bounds }
$sig = $null
if ($opts.PSObject.Properties["sig"] -and $null -ne $opts.sig) { $sig = $opts.sig }
$action = "readState"
if ($opts.PSObject.Properties["action"] -and $opts.action) { $action = [string]$opts.action }
$value = ""
if ($opts.PSObject.Properties["value"] -and $null -ne $opts.value) { $value = [string]$opts.value }

$pidTarget = 0
if ($opts.PSObject.Properties["pid"] -and $opts.pid) { $pidTarget = [int]$opts.pid }
$procName = ""
if ($opts.PSObject.Properties["processName"] -and $opts.processName) { $procName = [string]$opts.processName }
$titleTarget = ""
if ($opts.PSObject.Properties["windowTitle"] -and $opts.windowTitle) { $titleTarget = [string]$opts.windowTitle }
$desktopRoot = $false
if ($opts.PSObject.Properties["desktopRoot"] -and $opts.desktopRoot) { $desktopRoot = [bool]$opts.desktopRoot }

$script:found = $null
$script:matchedBy = ""

function Test-Signature($el) {
    if ($null -eq $sig) { return $false }
    $role = ""
    try { $role = $el.Current.ControlType.ProgrammaticName } catch { return $false }
    $role = ($role -replace "^ControlType\.", "").ToLowerInvariant()
    # normalize BOTH sides: "ControlType.Pane" and "pane" must compare equal
    $wantRole = (([string]$sig.role) -replace "^ControlType\.", "").ToLowerInvariant()
    if ($role -ne $wantRole) { return $false }
    $name = ""
    try { $name = [string]$el.Current.Name } catch {}
    if ($name -ne [string]$sig.name) { return $false }
    $autoId = ""
    try { $autoId = [string]$el.Current.AutomationId } catch {}
    if ($autoId -ne [string]$sig.autoId) { return $false }
    $elmPid = 0
    try { $elmPid = $el.Current.ProcessId } catch {}
    if ($sig.PSObject.Properties["pid"] -and $sig.pid -and [int]$sig.pid -ne $elmPid) { return $false }
    try {
        $r = $el.Current.BoundingRectangle
        if ($sig.PSObject.Properties["bounds"] -and $sig.bounds -and -not $r.IsEmpty) {
            if ([Math]::Abs($r.X - [double]$sig.bounds.x) -gt 2) { return $false }
            if ([Math]::Abs($r.Y - [double]$sig.bounds.y) -gt 2) { return $false }
            if ([Math]::Abs($r.Width - [double]$sig.bounds.width) -gt 2) { return $false }
            if ([Math]::Abs($r.Height - [double]$sig.bounds.height) -gt 2) { return $false }
        }
    } catch {}
    return $true
}

function Try-Match([System.Windows.Automation.AutomationElement]$el) {
    if ($script:found -ne $null) { return $true }
    try {
        $rid = (@($el.GetRuntimeId()) -join ",")
        if ($rid -eq $wantRid) {
            $script:found = $el
            $script:matchedBy = "runtimeId"
            return $true
        }
    } catch {}
    if (Test-Signature $el) {
        $script:found = $el
        $script:matchedBy = "signature"
        return $true
    }
    return $false
}

function Walk($el, [int]$depth) {
    if ($script:found -ne $null) { return }
    if (-not (Try-Match $el)) {
        if ($depth -ge $MaxDepth) { return }
        try {
            $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children,
                               [System.Windows.Automation.Condition]::TrueCondition)
            foreach ($k in $kids) {
                Walk $k ($depth + 1)
                if ($script:found -ne $null) { return }
            }
        } catch {}
    }
}

function Get-StateJson($el) {
    $patterns = @()
    try {
        foreach ($p in $el.GetSupportedPatterns()) {
            $pn = $p.ProgrammaticName
            if ($pn.Contains("InvokePattern")) { $patterns += "Invoke" }
            elseif ($pn.Contains("TogglePattern")) { $patterns += "Toggle" }
            elseif ($pn.Contains("ValuePattern")) { $patterns += "Value" }
            elseif ($pn.Contains("ExpandCollapsePattern")) { $patterns += "ExpandCollapse" }
            elseif ($pn.Contains("SelectionItemPattern")) { $patterns += "SelectionItem" }
        }
    } catch {}
    $val = ""
    try {
        if ($patterns -contains "Value") {
            $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            $val = $vp.Current.Value
        }
    } catch {}
    $toggleState = ""
    try {
        if ($patterns -contains "Toggle") {
            $tp = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
            $toggleState = [string]$tp.Current.ToggleState
        }
    } catch {}
    $expandState = ""
    try {
        if ($patterns -contains "ExpandCollapse") {
            $ep = $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
            $expandState = [string]$ep.Current.ExpandCollapseState
        }
    } catch {}
    $enabled = $true
    try { $enabled = [bool]$el.Current.IsEnabled } catch {}
    $name = ""
    try { $name = [string]$el.Current.Name } catch {}
    return @{
        ok        = $true
        runtimeId = $wantRid
        matchedBy = $script:matchedBy
        name      = $name
        value     = $val
        enabled   = $enabled
        patterns  = $patterns
        toggleState = $toggleState
        expandState = $expandState
        action    = $action
    }
}

try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement

    $roots = @()
    if ($desktopRoot -or ($pidTarget -eq 0 -and -not $procName -and -not $titleTarget)) {
        $roots = @($root)
    }
    elseif ($titleTarget) {
        # exact match first (fast), then substring fallback (agents pass
        # approximate/localized titles); on failure list what IS there
        $winCond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Window)
        $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)
        $win = $null
        foreach ($w in $wins) {
            if ($w.Current.Name -eq $titleTarget) { $win = $w; break }
        }
        if ($win -eq $null) {
            foreach ($w in $wins) {
                if ($w.Current.Name -like "*$titleTarget*") { $win = $w; break }
            }
        }
        if ($win -eq $null) {
            $names = @($wins | ForEach-Object { $_.Current.Name } | Where-Object { $_ } | Select-Object -First 12)
            [Console]::Error.WriteLine("ELEMENT_NOT_FOUND: no top-level window named '$titleTarget'. Visible windows: $($names -join ' | ')")
            exit 3
        }
        $roots = @($win)
    }
    else {
        $pids = @()
        if ($pidTarget -gt 0) { $pids += $pidTarget }
        elseif ($procName) {
            try {
                foreach ($p in (Get-Process -Name $procName -ErrorAction SilentlyContinue)) { $pids += $p.Id }
            } catch {}
        }
        if ($pids.Count -eq 0) {
            [Console]::Error.WriteLine("ELEMENT_NOT_FOUND: no process (pid=$pidTarget name=$procName)")
            exit 3
        }
        foreach ($p in $pids) {
            $cond = New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $p)
            $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
            foreach ($w in $wins) { $roots += $w }
        }
        if ($roots.Count -eq 0) {
            [Console]::Error.WriteLine("ELEMENT_NOT_FOUND: no top-level windows for pid(s) $($pids -join ',')")
            exit 3
        }
    }

    if ($action -eq "foreground") {
        $w0 = $roots[0]
        $hwnd = [IntPtr]([int]$w0.Current.NativeWindowHandle)
        if ($hwnd -eq [IntPtr]::Zero) {
            [Console]::Error.WriteLine("ACTION_FAILED: scoped window has no NativeWindowHandle")
            exit 5
        }
        if (-not ([System.Management.Automation.PSTypeName]'CuWin32FG').Type) {
            $fgSrc = @'
using System;
using System.Runtime.InteropServices;
public static class CuWin32FG {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr h);
}
'@
            Add-Type -TypeDefinition $fgSrc
        }
        $okFg = [CuWin32FG]::SetForegroundWindow($hwnd)
        Start-Sleep -Milliseconds 80
        @{ ok = [bool]$okFg; action = "foreground"; windowHandle = [int64]$hwnd } |
            ConvertTo-Json -Compress -Depth 3
        exit 0
    }
    foreach ($r0 in $roots) {
        Walk $r0 0
        if ($script:found -ne $null) { break }
    }
    if ($script:found -eq $null) {
        [Console]::Error.WriteLine("ELEMENT_NOT_FOUND: runtimeId $wantRid not present anymore (UI stale, re-observe)")
        exit 3
    }

    $el = $script:found

    switch ($action) {
        "readState" {
            ConvertTo-Json -InputObject (Get-StateJson $el) -Compress -Depth 4
            exit 0
        }
        "readBounds" {
            $r = $el.Current.BoundingRectangle
            $out = @{ ok = $true; runtimeId = $wantRid; action = "readBounds"; matchedBy = $script:matchedBy }
            if (-not $r.IsEmpty) {
                $out.bounds = @{ x = [int][Math]::Round($r.X); y = [int][Math]::Round($r.Y);
                                 width = [int][Math]::Round($r.Width); height = [int][Math]::Round($r.Height) }
            } else { $out.bounds = $null }
            ConvertTo-Json -InputObject $out -Compress -Depth 4
            exit 0
        }
        "invoke" {
            try {
                $p = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
            } catch {
                [Console]::Error.WriteLine("PATTERN_NOT_SUPPORTED: Invoke")
                exit 4
            }
            try { $p.Invoke() } catch {
                [Console]::Error.WriteLine("ACTION_FAILED: Invoke threw: $($_.Exception.Message)")
                exit 5
            }
            $out = (Get-StateJson $el)
            $out.invoked = $true
            ConvertTo-Json -InputObject $out -Compress -Depth 4
            exit 0
        }
        "toggle" {
            try {
                $p = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
            } catch {
                [Console]::Error.WriteLine("PATTERN_NOT_SUPPORTED: Toggle")
                exit 4
            }
            $before = [string]$p.Current.ToggleState
            if ($opts.PSObject.Properties["toggleValue"] -and $null -ne $opts.toggleValue) {
                $desired = ""
                if ([bool]$opts.toggleValue) { $desired = "On" } else { $desired = "Off" }
                if ($before -eq $desired) {
                    $out = (Get-StateJson $el)
                    $out.unchanged = $true
                    ConvertTo-Json -InputObject $out -Compress -Depth 4
                    exit 0
                }
            }
            try { $p.Toggle() } catch {
                [Console]::Error.WriteLine("ACTION_FAILED: Toggle threw: $($_.Exception.Message)")
                exit 5
            }
            # cheap verification: re-read the state
            try {
                $p2 = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
                $after = [string]$p2.Current.ToggleState
            } catch { $after = "" }
            $out = (Get-StateJson $el)
            $out.toggleBefore = $before
            $out.toggleAfter = $after
            ConvertTo-Json -InputObject $out -Compress -Depth 4
            exit 0
        }
        "setValue" {
            try {
                $p = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            } catch {
                [Console]::Error.WriteLine("PATTERN_NOT_SUPPORTED: Value")
                exit 4
            }
            try { $p.SetValue($value) } catch {
                [Console]::Error.WriteLine("ACTION_FAILED: SetValue threw: $($_.Exception.Message)")
                exit 5
            }
            # cheap verification: read back
            $after = ""
            try {
                $p2 = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                $after = $p2.Current.Value
            } catch {}
            $out = (Get-StateJson $el)
            $out.valueAfter = $after
            # single-line EDIT controls report a trailing \r — compare trimmed
            if ("$after".Trim() -ne "$value".Trim()) {
                [Console]::Error.WriteLine("VERIFY_FAILED: value read back '$after' != requested '$value'")
                exit 6
            }
            ConvertTo-Json -InputObject $out -Compress -Depth 4
            exit 0
        }
        "select" {
            $done = $false
            try {
                $p = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
                $p.Select()
                $done = $true
            } catch {}
            if (-not $done) {
                # fall back to Value pattern (combo edit) — caller handles coordinate fallback
                [Console]::Error.WriteLine("PATTERN_NOT_SUPPORTED: SelectionItem")
                exit 4
            }
            $out = (Get-StateJson $el)
            $out.selected = $true
            ConvertTo-Json -InputObject $out -Compress -Depth 4
            exit 0
        }
        "expand" {
            try {
                $p = $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
            } catch {
                [Console]::Error.WriteLine("PATTERN_NOT_SUPPORTED: ExpandCollapse")
                exit 4
            }
            try { $p.Expand() } catch {
                [Console]::Error.WriteLine("ACTION_FAILED: Expand threw: $($_.Exception.Message)")
                exit 5
            }
            $out = (Get-StateJson $el)
            ConvertTo-Json -InputObject $out -Compress -Depth 4
            exit 0
        }
        "collapse" {
            try {
                $p = $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
            } catch {
                [Console]::Error.WriteLine("PATTERN_NOT_SUPPORTED: ExpandCollapse")
                exit 4
            }
            try { $p.Collapse() } catch {
                [Console]::Error.WriteLine("ACTION_FAILED: Collapse threw: $($_.Exception.Message)")
                exit 5
            }
            $out = (Get-StateJson $el)
            ConvertTo-Json -InputObject $out -Compress -Depth 4
            exit 0
        }
        "setFocus" {
            try { $el.SetFocus() } catch {
                [Console]::Error.WriteLine("ACTION_FAILED: SetFocus threw: $($_.Exception.Message)")
                exit 5
            }
            $out = (Get-StateJson $el)
            $out.focused = $true
            ConvertTo-Json -InputObject $out -Compress -Depth 4
            exit 0
        }
        default {
            [Console]::Error.WriteLine("UIA_ERROR: unknown action '$action'")
            exit 5
        }
    }
}
catch {
    [Console]::Error.WriteLine("UIA_ERROR: $($_.Exception.Message)")
    exit 1
}
