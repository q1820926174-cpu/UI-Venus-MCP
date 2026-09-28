# Screen capture + display info (Windows).
# Physical pixels throughout: SetProcessDPIAware() is called BEFORE any
# Drawing/Forms use, so VirtualScreen / Screen.Bounds / CopyFromScreen all
# agree on physical pixels (multi-monitor virtual screen origin may be negative).
#
# Modes (via -Mode):
#   info     -> JSON { virtualScreen, displays[], dpi, scale, foreground }
#   capture  -> PNG written to -OutFile + JSON { ok, file, width, height,
#               avgR, avgG, avgB, blackRatio } (cheap black-screen detection)
# ArgsJson (base64 UTF-8 JSON) for capture: { region?, displayId? }
#   region is in physical screen coordinates.
#
# Exit codes: 0 ok · 8 CAPTURE_FAILED · 9 BAD_REGION · 1 unexpected.

param(
    [string]$Mode = "info",
    [string]$ArgsJson = "",
    [string]$OutFile = ""
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class CuScreen {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CuWin {
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
"@
# Must happen before any window/DPI-dependent call. Returns false if already set — ignore.
[void][CuScreen]::SetProcessDPIAware()

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

function Get-ForegroundInfo {
    $info = $null
    try {
        $hwnd = [CuScreen]::GetForegroundWindow()
        if ($hwnd -ne [IntPtr]::Zero) {
            $pidWin = [uint32]0
            [void][CuScreen]::GetWindowThreadProcessId($hwnd, [ref]$pidWin)
            $rect = New-Object CuScreen+RECT
            $hasRect = [CuScreen]::GetWindowRect($hwnd, [ref]$rect)
            $procName = ""
            try { $procName = (Get-Process -Id $pidWin -ErrorAction SilentlyContinue).ProcessName } catch {}
            $title = ""
            $sb = New-Object System.Text.StringBuilder 512
            [void][CuWin]::GetWindowText($hwnd, $sb, 512)
            $title = $sb.ToString()
            $info = @{
                pid     = [int]$pidWin
                process = $procName
                title   = $title
            }
            if ($hasRect) {
                $info.bounds = @{ x = $rect.Left; y = $rect.Top;
                                  width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top }
            }
        }
    } catch {}
    return $info
}

function Get-DpiInfo {
    $dpi = 96; $method = "fallback-96"
    try {
        $t = @"
using System;
using System.Runtime.InteropServices;
public static class CuDpi {
    [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
}
"@
        Add-Type -TypeDefinition $t -ErrorAction SilentlyContinue
        $dpi = [int][CuDpi]::GetDpiForSystem()
        $method = "GetDpiForSystem"
    } catch {
        # Win8.1 / older: approximate from Graphics DpiX (96 = 100%)
        try {
            $g = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
            $dpi = [int]$g.DpiX
            $g.Dispose()
            $method = "Graphics.DpiX"
        } catch {}
    }
    return @{ dpi = $dpi; scale = [Math]::Round($dpi / 96.0, 3); method = $method }
}

try {
    if ($Mode -eq "info") {
        $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $displays = @()
        $i = 0
        foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
            $b = $s.Bounds
            $displays += [ordered]@{
                id         = "$i"
                deviceName = $s.DeviceName
                x          = $b.X; y = $b.Y; width = $b.Width; height = $b.Height
                primary    = [bool]$s.Primary
            }
            $i++
        }
        $dpiInfo = Get-DpiInfo
        @{
            ok            = $true
            virtualScreen = @{ x = $vs.X; y = $vs.Y; width = $vs.Width; height = $vs.Height }
            displays      = $displays
            dpi           = $dpiInfo.dpi
            scale         = $dpiInfo.scale
            dpiMethod     = $dpiInfo.method
            foreground    = Get-ForegroundInfo
        } | ConvertTo-Json -Compress -Depth 6
        exit 0
    }

    if ($Mode -eq "capture") {
        if (-not $OutFile) {
            [Console]::Error.WriteLine("CAPTURE_FAILED: -OutFile is required for capture mode")
            exit 8
        }
        if ($ArgsJson -and -not $ArgsJson.StartsWith("{")) {
            $ArgsJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($ArgsJson))
        }
        $opts = @{}
        if ($ArgsJson) { $opts = ConvertFrom-Json $ArgsJson }

        $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $x = $vs.X; $y = $vs.Y; $w = $vs.Width; $h = $vs.Height
        $originLabel = "virtualScreen"

        if ($opts.PSObject.Properties["displayId"] -and $null -ne $opts.displayId) {
            $idx = [int]$opts.displayId
            $screens = [System.Windows.Forms.Screen]::AllScreens
            if ($idx -lt 0 -or $idx -ge $screens.Count) {
                [Console]::Error.WriteLine("BAD_REGION: displayId $idx out of range ($($screens.Count) displays)")
                exit 9
            }
            $b = $screens[$idx].Bounds
            $x = $b.X; $y = $b.Y; $w = $b.Width; $h = $b.Height
            $originLabel = "display:$idx"
        }

        if ($opts.PSObject.Properties["region"] -and $null -ne $opts.region -and $opts.region) {
            $rx = [int]$opts.region.x; $ry = [int]$opts.region.y
            $rw = [int]$opts.region.width; $rh = [int]$opts.region.height
            # clamp to virtual screen
            $cx1 = [Math]::Max($vs.X, $rx)
            $cy1 = [Math]::Max($vs.Y, $ry)
            $cx2 = [Math]::Min($vs.X + $vs.Width, $rx + $rw)
            $cy2 = [Math]::Min($vs.Y + $vs.Height, $ry + $rh)
            if (($cx2 - $cx1) -lt 1 -or ($cy2 - $cy1) -lt 1) {
                [Console]::Error.WriteLine("BAD_REGION: region ($rx,$ry,$rw,$rh) does not intersect the virtual screen")
                exit 9
            }
            $x = $cx1; $y = $cy1; $w = $cx2 - $cx1; $h = $cy2 - $cy1
            $originLabel = "region"
        }

        $bmp = New-Object System.Drawing.Bitmap $w, $h
        try {
            try {
                $g = [System.Drawing.Graphics]::FromImage($bmp)
                try {
                    $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $h))
                } finally {
                    $g.Dispose()
                }
                $bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
            } catch {
                [Console]::Error.WriteLine("CAPTURE_FAILED: $($_.Exception.Message)")
                exit 8
            }
        } finally {
            $bmp.Dispose()
        }

        # Cheap content stats: sample ~10k pixels for average RGB + black ratio.
        $bmp2 = New-Object System.Drawing.Bitmap $OutFile
        try {
            $total = [double]0; $sumR = [double]0; $sumG = [double]0; $sumB = [double]0
            $n = 0; $black = 0
            $stepX = [Math]::Max(1, [int]($bmp2.Width / 100))
            $stepY = [Math]::Max(1, [int]($bmp2.Height / 100))
            for ($sy = 0; $sy -lt $bmp2.Height; $sy += $stepY) {
                for ($sx = 0; $sx -lt $bmp2.Width; $sx += $stepX) {
                    $c = $bmp2.GetPixel($sx, $sy)
                    $lum = 0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B
                    $total += $lum
                    $sumR += $c.R; $sumG += $c.G; $sumB += $c.B
                    if ($lum -lt 4) { $black++ }
                    $n++
                }
            }
            $avgLum = if ($n -gt 0) { [Math]::Round($total / $n, 2) } else { 0 }
            @{
                ok         = $true
                mode       = "capture"
                file       = $OutFile
                originKind = $originLabel
                origin     = @{ x = $x; y = $y }
                width      = $w
                height     = $h
                avgR       = if ($n -gt 0) { [Math]::Round($sumR / $n, 2) } else { 0 }
                avgG       = if ($n -gt 0) { [Math]::Round($sumG / $n, 2) } else { 0 }
                avgB       = if ($n -gt 0) { [Math]::Round($sumB / $n, 2) } else { 0 }
                avgLuma    = $avgLum
                sampled    = $n
                blackRatio = if ($n -gt 0) { [Math]::Round($black / $n, 4) } else { 1 }
            } | ConvertTo-Json -Compress -Depth 4
            exit 0
        } finally {
            $bmp2.Dispose()
        }
    }

    [Console]::Error.WriteLine("SCREEN_ERROR: unknown mode '$Mode'")
    exit 1
}
catch {
    [Console]::Error.WriteLine("SCREEN_ERROR: $($_.Exception.Message)")
    exit 1
}
