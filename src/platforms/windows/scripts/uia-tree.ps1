# UIA tree walker — Windows UI Automation via .NET System.Windows.Automation.
# Emits a flat, DFS-ordered JSON array of elements (depth field allows the
# caller to rebuild the hierarchy). Bounds are PHYSICAL screen pixels.
#
# ArgsJson (base64 UTF-8 JSON), all optional:
#   pid          [int]    top-level windows of this process
#   processName  [string] resolve process name -> pids -> windows
#   windowTitle  [string] top-level window with this exact Name
#   desktopRoot  [bool]   walk the desktop root itself (mode "desktop")
# Named params: -MaxDepth / -MaxNodes override caps.
#
# Exit codes: 0 ok · 3 PROCESS_NOT_FOUND · 1 unexpected error (stderr).

param(
    [string]$ArgsJson = "",
    [int]$MaxDepth = 14,
    [int]$MaxNodes = 600
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

if (-not $ArgsJson.StartsWith("{")) {
    if ($ArgsJson) {
        $ArgsJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($ArgsJson))
    }
}
$opts = @{}
if ($ArgsJson) { $opts = ConvertFrom-Json $ArgsJson }

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$pidTarget = 0
if ($opts.PSObject.Properties["pid"] -and $opts.pid) { $pidTarget = [int]$opts.pid }
$procName = ""
if ($opts.PSObject.Properties["processName"] -and $opts.processName) { $procName = [string]$opts.processName }
$titleTarget = ""
if ($opts.PSObject.Properties["windowTitle"] -and $opts.windowTitle) { $titleTarget = [string]$opts.windowTitle }
$desktopRoot = $false
if ($opts.PSObject.Properties["desktopRoot"] -and $opts.desktopRoot) { $desktopRoot = [bool]$opts.desktopRoot }

$script:list = New-Object System.Collections.Generic.List[object]
$script:count = 0

function Get-PatternNames([System.Windows.Automation.AutomationElement]$el) {
    $names = @()
    try {
        foreach ($p in $el.GetSupportedPatterns()) {
            $pn = $p.ProgrammaticName
            if ($pn -eq $null) { continue }
            if ($pn.Contains("InvokePattern")) { $names += "Invoke" }
            elseif ($pn.Contains("TogglePattern")) { $names += "Toggle" }
            elseif ($pn.Contains("ValuePattern")) { $names += "Value" }
            elseif ($pn.Contains("ExpandCollapsePattern")) { $names += "ExpandCollapse" }
            elseif ($pn.Contains("LegacyIAccessiblePattern")) { $names += "LegacyIAccessible" }
            elseif ($pn.Contains("SelectionItemPattern")) { $names += "SelectionItem" }
            elseif ($pn.Contains("SelectionPattern")) { $names += "Selection" }
            elseif ($pn.Contains("RangeValuePattern")) { $names += "RangeValue" }
            elseif ($pn.Contains("ScrollItemPattern")) { $names += "ScrollItem" }
            elseif ($pn.Contains("ScrollPattern")) { $names += "Scroll" }
            elseif ($pn.Contains("WindowPattern")) { $names += "Window" }
            elseif ($pn.Contains("DockPattern")) { $names += "Dock" }
            elseif ($pn.Contains("TableItemPattern")) { $names += "TableItem" }
            elseif ($pn.Contains("TablePattern")) { $names += "Table" }
            elseif ($pn.Contains("GridItemPattern")) { $names += "GridItem" }
            elseif ($pn.Contains("GridPattern")) { $names += "Grid" }
            elseif ($pn.Contains("TextPattern")) { $names += "Text" }
        }
    } catch {}
    return ,$names
}

function Get-ElementValue($el, $patterns) {
    try {
        if ($patterns -contains "Value") {
            $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            $v = $vp.Current.Value
            if ($v -and $v.Length -gt 200) { return $v.Substring(0, 200) }
            return $v
        }
    } catch {}
    return ""
}

function Walk($el, [int]$depth) {
    if ($script:count -ge $MaxNodes) { return }

    $rid = ""
    try { $rid = (@($el.GetRuntimeId()) -join ",") } catch { return }

    $role = ""
    try { $role = $el.Current.ControlType.ProgrammaticName } catch { return }

    $name = ""
    try {
        $name = $el.Current.Name
        if ($name -eq $null) { $name = "" }
        if ($name.Length -gt 200) { $name = $name.Substring(0, 200) }
    } catch {}

    $enabled = $true
    try { $enabled = [bool]$el.Current.IsEnabled } catch {}

    $elmPid = 0
    try { $elmPid = $el.Current.ProcessId } catch {}

    $className = ""
    try { $className = [string]$el.Current.ClassName } catch {}

    $autoId = ""
    try { $autoId = [string]$el.Current.AutomationId } catch {}

    $hasBounds = $false
    $bx = 0; $by = 0; $bw = 0; $bh = 0
    try {
        $r = $el.Current.BoundingRectangle
        if (-not $r.IsEmpty -and $r.Width -gt 0 -and $r.Height -gt 0) {
            $bx = [int][Math]::Round($r.X); $by = [int][Math]::Round($r.Y)
            $bw = [int][Math]::Round($r.Width); $bh = [int][Math]::Round($r.Height)
            $hasBounds = $true
        }
    } catch {}

    $patterns = Get-PatternNames $el
    $value = Get-ElementValue $el $patterns

    $boundsObj = $null
    if ($hasBounds) {
        $boundsObj = @{ x = $bx; y = $by; width = $bw; height = $bh }
    }

    $item = [ordered]@{
        runtimeId = $rid
        role      = $role
        name      = $name
        value     = $value
        enabled   = $enabled
        bounds    = $boundsObj
        patterns  = $patterns
        depth     = $depth
        pid       = $elmPid
        className = $className
        autoId    = $autoId
    }
    $script:list.Add($item)
    $script:count++

    if ($depth -lt $MaxDepth) {
        try {
            $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children,
                               [System.Windows.Automation.Condition]::TrueCondition)
            foreach ($k in $kids) { Walk $k ($depth + 1) }
        } catch {}
    }
}

function Resolve-ProcessPids([string]$name) {
    $pids = @()
    try {
        $procs = Get-Process -Name $name -ErrorAction SilentlyContinue
        foreach ($p in $procs) { $pids += $p.Id }
    } catch {}
    return ,$pids
}

try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement

    if ($desktopRoot -or ($pidTarget -eq 0 -and -not $procName -and -not $titleTarget)) {
        # Desktop root mode: the root element itself is the tree root.
        Walk $root 0
    }
    elseif ($titleTarget) {
        $cond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::NameProperty, $titleTarget)
        $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
        if ($win -eq $null) {
            [Console]::Error.WriteLine("PROCESS_NOT_FOUND: no top-level window named '$titleTarget'")
            exit 3
        }
        Walk $win 0
    }
    else {
        $pids = @()
        if ($pidTarget -gt 0) { $pids += $pidTarget }
        elseif ($procName) { $pids = Resolve-ProcessPids $procName }
        if ($pids.Count -eq 0) {
            [Console]::Error.WriteLine("PROCESS_NOT_FOUND: no process (pid=$pidTarget name=$procName)")
            exit 3
        }
        $foundAny = $false
        foreach ($p in $pids) {
            $cond = New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $p)
            $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
            foreach ($w in $wins) {
                $foundAny = $true
                Walk $w 0
                if ($script:count -ge $MaxNodes) { break }
            }
        }
        if (-not $foundAny) {
            [Console]::Error.WriteLine("PROCESS_NOT_FOUND: no top-level windows for pid(s) $($pids -join ',') (may be UAC-elevated, or has no window)")
            exit 3
        }
    }

    ConvertTo-Json -InputObject $script:list -Compress -Depth 6
    exit 0
}
catch {
    [Console]::Error.WriteLine("UIA_ERROR: $($_.Exception.Message)")
    exit 1
}
