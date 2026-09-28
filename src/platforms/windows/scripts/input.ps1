# SendInput-based input injection — mouse + keyboard (Windows).
#
# Modes (via -Mode):
#   move    {x,y}                          physical pixels
#   click   {x,y,button:"left"|"right",clicks}
#   drag    {fromX,fromY,toX,toY,durationMs}
#   scroll  {x,y,direction:"up"|"down"|"left"|"right",amount}
#   type    {text}                        unicode via KEYEVENTF_UNICODE
#   key     {key, modifiers:[...]}        virtual-key press with modifiers
# ArgsJson carries the payload (base64 UTF-8 JSON).
#
# Honesty: SendInput's return value (events actually injected) is checked;
# for mouse ops GetCursorPos is read back and reported.
#
# Exit codes: 0 ok · 6 INPUT_FAILED (SendInput injected 0 events) ·
#             7 UNKNOWN_KEY · 1 unexpected error.

param(
    [string]$Mode = "",
    [string]$ArgsJson = ""
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class CuInput {
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx; public int dy;
        public uint mouseData; public uint dwFlags; public uint time;
        public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk; public ushort wScan;
        public uint dwFlags; public uint time;
        public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT {
        public uint uMsg; public ushort wParamL; public ushort wParamH;
    }
    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public INPUTUNION u;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetCursorPos(out POINT p);

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);

    public struct POINT { public int X; public int Y; }

    public const uint MOUSEEVENTF_MOVE        = 0x0001;
    public const uint MOUSEEVENTF_LEFTDOWN    = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP      = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN   = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP     = 0x0010;
    public const uint MOUSEEVENTF_ABSOLUTE    = 0x8000;
    public const uint MOUSEEVENTF_WHEEL       = 0x0800;
    public const uint MOUSEEVENTF_HWHEEL      = 0x1000;
    public const uint KEYEVENTF_KEYUP         = 0x0002;
    public const uint KEYEVENTF_UNICODE       = 0x0004;

    public const int SM_XVIRTUALSCREEN  = 76;
    public const int SM_YVIRTUALSCREEN  = 77;
    public const int SM_CXVIRTUALSCREEN = 78;
    public const int SM_CYVIRTUALSCREEN = 79;

    public static INPUT[] MakeMouse(uint flags, int dx, int dy, uint data) {
        var arr = new INPUT[1];
        arr[0].type = 0; // INPUT_MOUSE
        arr[0].u.mi.dx = dx; arr[0].u.mi.dy = dy;
        arr[0].u.mi.mouseData = data;
        arr[0].u.mi.dwFlags = flags;
        arr[0].u.mi.time = 0;
        arr[0].u.mi.dwExtraInfo = IntPtr.Zero;
        return arr;
    }
    public static INPUT[] MakeKey(ushort vk, ushort scan, uint flags) {
        var arr = new INPUT[1];
        arr[0].type = 1; // INPUT_KEYBOARD
        arr[0].u.ki.wVk = vk; arr[0].u.ki.wScan = scan;
        arr[0].u.ki.dwFlags = flags;
        arr[0].u.ki.time = 0;
        arr[0].u.ki.dwExtraInfo = IntPtr.Zero;
        return arr;
    }
    public static uint Send(INPUT[] events) {
        return SendInput((uint)events.Length, events, Marshal.SizeOf(typeof(INPUT)));
    }
    public static object Cursor() {
        POINT p;
        if (GetCursorPos(out p)) return new { x = p.X, y = p.Y };
        return null;
    }
}
"@

if ($ArgsJson -and -not $ArgsJson.StartsWith("{")) {
    $ArgsJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($ArgsJson))
}
$opts = @{}
if ($ArgsJson) { $opts = ConvertFrom-Json $ArgsJson }

$script:cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][CuInput+INPUT])

function Get-VirtualScreen {
    $vx = [CuInput]::GetSystemMetrics([CuInput]::SM_XVIRTUALSCREEN)
    $vy = [CuInput]::GetSystemMetrics([CuInput]::SM_YVIRTUALSCREEN)
    $vw = [CuInput]::GetSystemMetrics([CuInput]::SM_CXVIRTUALSCREEN)
    $vh = [CuInput]::GetSystemMetrics([CuInput]::SM_CYVIRTUALSCREEN)
    return @{ x = $vx; y = $vy; w = $vw; h = $vh }
}

# Physical pixels -> SendInput absolute normalized coordinates (0..65535)
# across the virtual screen. Requires a DPI-aware process for physical metrics.
function ConvertTo-Absolute([int]$px, [int]$py, $vs) {
    $nx = 0; $ny = 0
    if ($vs.w -gt 1) { $nx = [int][Math]::Round((($px - $vs.x) * 65535.0) / ($vs.w - 1)) }
    if ($vs.h -gt 1) { $ny = [int][Math]::Round((($py - $vs.y) * 65535.0) / ($vs.h - 1)) }
    if ($nx -lt 0) { $nx = 0 } ; if ($nx -gt 65535) { $nx = 65535 }
    if ($ny -lt 0) { $ny = 0 } ; if ($ny -gt 65535) { $ny = 65535 }
    return @{ x = $nx; y = $ny }
}

function Send-OrFail($events, [string]$what) {
    $sent = [CuInput]::Send($events)
    if ($sent -ne [uint32]$events.Length) {
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        [Console]::Error.WriteLine("INPUT_FAILED: $what injected $sent of $($events.Length) events (Win32Error=$err)")
        exit 6
    }
    return $sent
}

$VK = @{
    "backspace"=0x08; "delete"=0x2E; "del"=0x2E; "tab"=0x09; "enter"=0x0D; "return"=0x0D;
    "escape"=0x1B; "esc"=0x1B; "space"=0x20; "pageup"=0x21; "pgup"=0x21; "pagedown"=0x22; "pgdn"=0x22;
    "end"=0x23; "home"=0x24; "left"=0x25; "up"=0x26; "right"=0x27; "down"=0x28; "insert"=0x2D;
    "printscreen"=0x2C; "capslock"=0x14; "numlock"=0x90; "scrolllock"=0x91; "win"=0x5B; "menu"=0x5D;
}
for ($i = 1; $i -le 24; $i++) { $VK[("f" + $i)] = 0x70 + $i - 1 }
for ($i = 0; $i -le 9; $i++) { $VK[([string]$i)] = 0x30 + $i }
foreach ($c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ".ToCharArray()) { $VK[([string]$c).ToLower()] = [int]$c }
$VK[";"]=0xBA; $VK["="]=0xBB; $VK[","]=0xBC; $VK["-"]=0xBD; $VK["."]=0xBE; $VK["/"]=0xBF;
$VK['`']=0xC0; $VK['[']=0xDB; $VK['\']=0xDC; $VK[']']=0xDD; $VK["'"]=0xDE

$MOD = @{ "shift"=0x10; "ctrl"=0x11; "control"=0x11; "alt"=0x12; "win"=0x5B; "meta"=0x5B; "cmd"=0x5B; "command"=0x5B }

function Resolve-VK([string]$key) {
    $k = $key.Trim().ToLower()
    if ($VK.ContainsKey($k)) { return $VK[$k] }
    if ($k.Length -eq 1) { return [int][char]$k.ToUpper() }
    return -1
}

try {
    switch ($Mode) {
        "move" {
            $x = [int]$opts.x; $y = [int]$opts.y
            $vs = Get-VirtualScreen
            $abs = ConvertTo-Absolute $x $y $vs
            Send-OrFail ([CuInput]::MakeMouse([CuInput]::MOUSEEVENTF_MOVE -bor [CuInput]::MOUSEEVENTF_ABSOLUTE, $abs.x, $abs.y, 0)) "move"
            Start-Sleep -Milliseconds 10
            @{ ok = $true; mode = "move"; requested = @{ x = $x; y = $y }; cursor = [CuInput]::Cursor() } |
                ConvertTo-Json -Compress -Depth 4
            exit 0
        }
        "click" {
            $x = [int]$opts.x; $y = [int]$opts.y
            $button = "left"
            if ($opts.PSObject.Properties["button"] -and $opts.button) { $button = [string]$opts.button }
            $clicks = 1
            if ($opts.PSObject.Properties["clicks"] -and $opts.clicks) { $clicks = [int]$opts.clicks }
            $vs = Get-VirtualScreen
            $abs = ConvertTo-Absolute $x $y $vs
            $down = [CuInput]::MOUSEEVENTF_LEFTDOWN; $up = [CuInput]::MOUSEEVENTF_LEFTUP
            if ($button -eq "right") { $down = [CuInput]::MOUSEEVENTF_RIGHTDOWN; $up = [CuInput]::MOUSEEVENTF_RIGHTUP }
            # position first so hover state is correct
            Send-OrFail ([CuInput]::MakeMouse([CuInput]::MOUSEEVENTF_MOVE -bor [CuInput]::MOUSEEVENTF_ABSOLUTE, $abs.x, $abs.y, 0)) "click-move"
            for ($i = 1; $i -le $clicks; $i++) {
                Send-OrFail ([CuInput]::MakeMouse($down, 0, 0, 0)) "click-down#$i"
                Start-Sleep -Milliseconds 15
                Send-OrFail ([CuInput]::MakeMouse($up, 0, 0, 0)) "click-up#$i"
                if ($i -lt $clicks) { Start-Sleep -Milliseconds 30 }
            }
            @{ ok = $true; mode = "click"; button = $button; clicks = $clicks;
               requested = @{ x = $x; y = $y }; cursor = [CuInput]::Cursor() } |
                ConvertTo-Json -Compress -Depth 4
            exit 0
        }
        "drag" {
            $fx = [int]$opts.fromX; $fy = [int]$opts.fromY
            $tx = [int]$opts.toX; $ty = [int]$opts.toY
            $dur = 400
            if ($opts.PSObject.Properties["durationMs"] -and $opts.durationMs) { $dur = [int]$opts.durationMs }
            $vs = Get-VirtualScreen
            $from = ConvertTo-Absolute $fx $fy $vs
            $to = ConvertTo-Absolute $tx $ty $vs
            Send-OrFail ([CuInput]::MakeMouse([CuInput]::MOUSEEVENTF_MOVE -bor [CuInput]::MOUSEEVENTF_ABSOLUTE, $from.x, $from.y, 0)) "drag-move"
            Start-Sleep -Milliseconds 50
            Send-OrFail ([CuInput]::MakeMouse([CuInput]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0)) "drag-down"
            $steps = [Math]::Max(8, [Math]::Min(40, [int]($dur / 15)))
            for ($i = 1; $i -le $steps; $i++) {
                $ax = $from.x + [int](($to.x - $from.x) * $i / $steps)
                $ay = $from.y + [int](($to.y - $from.y) * $i / $steps)
                Send-OrFail ([CuInput]::MakeMouse([CuInput]::MOUSEEVENTF_MOVE -bor [CuInput]::MOUSEEVENTF_ABSOLUTE, $ax, $ay, 0)) "drag-move#$i"
                Start-Sleep -Milliseconds 10
            }
            Send-OrFail ([CuInput]::MakeMouse([CuInput]::MOUSEEVENTF_LEFTUP, 0, 0, 0)) "drag-up"
            @{ ok = $true; mode = "drag"; from = @{ x = $fx; y = $fy }; to = @{ x = $tx; y = $ty };
               cursor = [CuInput]::Cursor() } |
                ConvertTo-Json -Compress -Depth 4
            exit 0
        }
        "scroll" {
            $x = [int]$opts.x; $y = [int]$opts.y
            $direction = [string]$opts.direction
            $amount = 3.0
            if ($opts.PSObject.Properties["amount"] -and $opts.amount) { $amount = [double]$opts.amount }
            $notches = [Math]::Max(1, [int][Math]::Round([Math]::Abs($amount)))
            $vs = Get-VirtualScreen
            $abs = ConvertTo-Absolute $x $y $vs
            Send-OrFail ([CuInput]::MakeMouse([CuInput]::MOUSEEVENTF_MOVE -bor [CuInput]::MOUSEEVENTF_ABSOLUTE, $abs.x, $abs.y, 0)) "scroll-move"
            for ($i = 0; $i -lt $notches; $i++) {
                if ($direction -eq "up" -or $direction -eq "down") {
                    $delta = [uint32]120
                    if ($direction -eq "down") { $delta = [uint32]4294967176 } # -120 as uint32
                    Send-OrFail ([CuInput]::MakeMouse([CuInput]::MOUSEEVENTF_WHEEL, 0, 0, $delta)) "scroll-wheel#$i"
                }
                else {
                    $delta = [uint32]4294967176 # left = -120
                    if ($direction -eq "right") { $delta = [uint32]120 }
                    Send-OrFail ([CuInput]::MakeMouse([CuInput]::MOUSEEVENTF_HWHEEL, 0, 0, $delta)) "scroll-hwheel#$i"
                }
                Start-Sleep -Milliseconds 20
            }
            @{ ok = $true; mode = "scroll"; direction = $direction; notches = $notches;
               requested = @{ x = $x; y = $y }; cursor = [CuInput]::Cursor() } |
                ConvertTo-Json -Compress -Depth 4
            exit 0
        }
        "type" {
            $text = [string]$opts.text
            if ($text.Length -eq 0) {
                @{ ok = $true; mode = "type"; units = 0 } | ConvertTo-Json -Compress
                exit 0
            }
            # Build event list: \n / \r\n become VK_RETURN; everything else KEYEVENTF_UNICODE per UTF-16 unit.
            $events = New-Object System.Collections.Generic.List[object]
            $units = $text.ToCharArray()
            foreach ($ch in $units) {
                $code = [int]$ch
                if ($code -eq 10 -or $code -eq 13) {
                    if ($code -eq 13) { continue } # \r\n collapses to one Enter via the \n
                    $events.Add(@{ kind = "vk"; vk = 0x0D; flags = 0 })
                    $events.Add(@{ kind = "vk"; vk = 0x0D; flags = [CuInput]::KEYEVENTF_KEYUP })
                }
                else {
                    $events.Add(@{ kind = "uni"; scan = $code; flags = [CuInput]::KEYEVENTF_UNICODE })
                    $events.Add(@{ kind = "uni"; scan = $code; flags = [CuInput]::KEYEVENTF_UNICODE -bor [CuInput]::KEYEVENTF_KEYUP })
                }
            }
            # send in chunks so slow apps don't drop events
            $chunk = 24
            for ($i = 0; $i -lt $events.Count; $i += $chunk) {
                $end = [Math]::Min($events.Count, $i + $chunk)
                $batch = New-Object System.Collections.Generic.List[CuInput+INPUT]
                for ($j = $i; $j -lt $end; $j++) {
                    $e = $events[$j]
                    if ($e.kind -eq "vk") { $batch.Add([CuInput]::MakeKey([uint16]$e.vk, [uint16]0, [uint32]$e.flags)[0]) }
                    else { $batch.Add([CuInput]::MakeKey([uint16]0, [uint16]$e.scan, [uint32]$e.flags)[0]) }
                }
                Send-OrFail ($batch.ToArray()) "type-chunk"
                Start-Sleep -Milliseconds 8
            }
            @{ ok = $true; mode = "type"; units = $units.Length } | ConvertTo-Json -Compress -Depth 4
            exit 0
        }
        ("key") {
            $keyName = [string]$opts.key
            $vk = Resolve-VK $keyName
            if ($vk -lt 0) {
                [Console]::Error.WriteLine("UNKNOWN_KEY: $keyName")
                exit 7
            }
            $mods = @()
            if ($opts.PSObject.Properties["modifiers"] -and $opts.modifiers) { $mods = @($opts.modifiers) }
            foreach ($m in $mods) {
                $mk = ([string]$m).ToLower()
                if (-not $MOD.ContainsKey($mk)) {
                    [Console]::Error.WriteLine("UNKNOWN_KEY: modifier $m")
                    exit 7
                }
                Send-OrFail ([CuInput]::MakeKey([uint16]$MOD[$mk], [uint16]0, [uint32]0)) "mod-down $m"
            }
            Send-OrFail ([CuInput]::MakeKey([uint16]$vk, [uint16]0, [uint32]0)) "key-down $keyName"
            Start-Sleep -Milliseconds 15
            Send-OrFail ([CuInput]::MakeKey([uint16]$vk, [uint16]0, [uint32][CuInput]::KEYEVENTF_KEYUP)) "key-up $keyName"
            $rev = @($mods | ForEach-Object { $MOD[([string]$_).ToLower()] })
            if ($rev.Count -gt 0) { [array]::Reverse($rev) }
            foreach ($vkMod in $rev) {
                Send-OrFail ([CuInput]::MakeKey([uint16]$vkMod, [uint16]0, [uint32][CuInput]::KEYEVENTF_KEYUP)) "mod-up"
            }
            @{ ok = $true; mode = "key"; key = $keyName; modifiers = $mods } | ConvertTo-Json -Compress -Depth 4
            exit 0
        }
        default {
            [Console]::Error.WriteLine("INPUT_FAILED: unknown mode '$Mode'")
            exit 6
        }
    }
}
catch {
    [Console]::Error.WriteLine("INPUT_FAILED: $($_.Exception.Message)")
    exit 1
}
