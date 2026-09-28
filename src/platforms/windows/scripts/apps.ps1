# App lifecycle helpers (Windows): launch / kill / exists with verification.
#
# Actions (via -Action):
#   launch  {app, args?[]}   Start-Process -PassThru -> { ok, pid, name }
#   kill    {name?|pid?}     Stop-Process -Force      -> { ok, killed:[pids] }
#   exists  {name?|pid?}                              -> { ok, exists, pids }
#
# Exit codes: 0 ok · 3 APP_NOT_FOUND · 1 unexpected.

param(
    [string]$Action = "exists",
    [string]$ArgsJson = ""
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

if ($ArgsJson -and -not $ArgsJson.StartsWith("{")) {
    $ArgsJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($ArgsJson))
}
$opts = @{}
if ($ArgsJson) { $opts = ConvertFrom-Json $ArgsJson }

function Get-TargetProcesses {
    $found = @()
    if ($opts.PSObject.Properties["pid"] -and $opts.pid) {
        $p = Get-Process -Id ([int]$opts.pid) -ErrorAction SilentlyContinue
        if ($p) { $found += $p }
    }
    elseif ($opts.PSObject.Properties["name"] -and $opts.name) {
        $found = @(Get-Process -Name ([string]$opts.name) -ErrorAction SilentlyContinue)
    }
    return ,$found
}

try {
    switch ($Action) {
        "launch" {
            $app = [string]$opts.app
            if (-not $app) {
                [Console]::Error.WriteLine("APP_NOT_FOUND: launch requires app")
                exit 3
            }
            $argList = ""
            if ($opts.PSObject.Properties["args"] -and $opts.args) {
                $argList = (@($opts.args) | ForEach-Object { '"' + ([string]$_).Replace('"', '\"') + '"' }) -join " "
            }
            try {
                if ($argList) {
                    $proc = Start-Process -FilePath $app -ArgumentList $argList -PassThru -ErrorAction Stop
                } else {
                    $proc = Start-Process -FilePath $app -PassThru -ErrorAction Stop
                }
                @{ ok = $true; action = "launch"; app = $app; pid = $proc.Id; name = $proc.ProcessName } |
                    ConvertTo-Json -Compress -Depth 4
                exit 0
            } catch {
                [Console]::Error.WriteLine("APP_NOT_FOUND: cannot launch '$app': $($_.Exception.Message)")
                exit 3
            }
        }
        "kill" {
            $procs = Get-TargetProcesses
            if ($procs.Count -eq 0) {
                [Console]::Error.WriteLine("APP_NOT_FOUND: no process (pid=$($opts.pid) name=$($opts.name))")
                exit 3
            }
            $killed = @()
            foreach ($p in $procs) {
                try { Stop-Process -Id $p.Id -Force -ErrorAction Stop; $killed += $p.Id } catch {}
            }
            @{ ok = $true; action = "kill"; killed = $killed } | ConvertTo-Json -Compress -Depth 4
            exit 0
        }
        "exists" {
            $procs = Get-TargetProcesses
            @{ ok = $true; action = "exists"; exists = ($procs.Count -gt 0);
               pids = @($procs | ForEach-Object { $_.Id }) } | ConvertTo-Json -Compress -Depth 4
            exit 0
        }
        default {
            [Console]::Error.WriteLine("APPS_ERROR: unknown action '$Action'")
            exit 1
        }
    }
}
catch {
    [Console]::Error.WriteLine("APPS_ERROR: $($_.Exception.Message)")
    exit 1
}
