# Shows, restores and moves onto the screen the browser windows of one slot's chrome-devtools
# Chromium without activating them, for plugins/show-chromium.js. The caller was started
# hidden, so its first ShowWindow would be turned into SW_HIDE; SetWindowPos and
# ShowWindowAsync are not subject to that rule.
#
# Prints the browser's process ID once it has a window. Exits 0 when every window ends up
# visible, restored and on a screen, 1 when the slot's browser or its window does not exist
# yet, 2 when a window still is not.
#
# Adapted from fertilizer_management's .claude/skills/chrome-devtools/scripts/show_window.ps1
# at commit a9e66510.
param([Parameter(Mandatory)][ValidatePattern('^\d+$')][string] $Slot)

Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class ShowChromium {
    public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(long point, uint flags);
    [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hwnd, int command);
    public static List<IntPtr> WindowsOf(uint processId) {
        var found = new List<IntPtr>();
        EnumWindows((hwnd, lParam) => { uint owner; GetWindowThreadProcessId(hwnd, out owner); if (owner == processId) found.Add(hwnd); return true; }, IntPtr.Zero);
        return found;
    }
}
'@

$N = [ShowChromium]
$SWP_NOSIZE = 0x0001; $SWP_NOMOVE = 0x0002; $SWP_NOZORDER = 0x0004; $SWP_NOACTIVATE = 0x0010; $SWP_SHOWWINDOW = 0x0040
$SW_SHOWNOACTIVATE = 4
$MONITOR_DEFAULTTONULL = 0; $MONITOR_DEFAULTTOPRIMARY = 1

$onScreen = { param($hwnd) $N::MonitorFromWindow($hwnd, $MONITOR_DEFAULTTONULL) -ne [IntPtr]::Zero }

# The browser process: this exact profile, and no --type=, which every child process carries.
$pattern = '--user-data-dir="?[^"]*[\\/]chrome-devtools-mcp[\\/]opencode-profile-' + $Slot + '(?=["\s]|$)'
$browser = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
    Where-Object { $_.CommandLine -match $pattern -and $_.CommandLine -notmatch '--type=' } |
    Select-Object -First 1

if (-not $browser) { exit 1 }

# Browser frames only: menus, popups and bubbles lack a caption (WS_CAPTION) or have an owner.
$frames = @(foreach ($hwnd in $N::WindowsOf($browser.ProcessId)) {
    $class = [Text.StringBuilder]::new(64)
    [void]$N::GetClassName($hwnd, $class, 64)

    if ($class.ToString() -eq 'Chrome_WidgetWin_1' -and
        ($N::GetWindowLong($hwnd, -16) -band 0x00C00000) -eq 0x00C00000 -and
        $N::GetWindow($hwnd, 4) -eq [IntPtr]::Zero) {
        $hwnd
    }
})

if ($frames.Count -eq 0) { exit 1 }

$restored = $false

foreach ($hwnd in $frames) {
    [void]$N::SetWindowPos($hwnd, [IntPtr]::Zero, 0, 0, 0, 0,
        $SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_NOZORDER -bor $SWP_NOACTIVATE -bor $SWP_SHOWWINDOW)

    if ($N::IsIconic($hwnd)) {
        [void]$N::ShowWindowAsync($hwnd, $SW_SHOWNOACTIVATE)
        $restored = $true
    }
}

# The restore is asynchronous, and a minimized window reports its icon's place until it lands.
if ($restored) { Start-Sleep -Milliseconds 300 }

$work = (& {
    $info = New-Object ShowChromium+MonitorInfo
    $info.Size = [Runtime.InteropServices.Marshal]::SizeOf($info)
    [void]$N::GetMonitorInfo($N::MonitorFromPoint(0, $MONITOR_DEFAULTTOPRIMARY), [ref]$info)
    $info
}).Work

foreach ($hwnd in $frames | Where-Object { -not (& $onScreen $_) }) {
    $rect = New-Object ShowChromium+Rect
    [void]$N::GetWindowRect($hwnd, [ref]$rect)
    $width = [Math]::Min($rect.Right - $rect.Left, $work.Right - $work.Left)
    $height = [Math]::Min($rect.Bottom - $rect.Top, $work.Bottom - $work.Top)
    [void]$N::SetWindowPos($hwnd, [IntPtr]::Zero, $work.Left, $work.Top, $width, $height, $SWP_NOZORDER -bor $SWP_NOACTIVATE)
}

$browser.ProcessId

if ($frames | Where-Object { -not $N::IsWindowVisible($_) -or $N::IsIconic($_) -or -not (& $onScreen $_) }) { exit 2 }
