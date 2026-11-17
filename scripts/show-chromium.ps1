# Shows the hidden browser windows of one slot's chrome-devtools Chromium at the bottom of the
# Z-order and moves those off every screen onto the primary one, without activating them, for
# plugins/show-chromium.js. The window stays reachable from the taskbar and never covers the
# user's work. A minimized window is left minimized: restoring one makes Chromium take the
# focus. The caller was started hidden, so its first ShowWindow would be turned into SW_HIDE;
# SetWindowPos is not subject to that rule.
#
# Prints the browser's process ID once it has a window. Exits 0 when every window that is not
# minimized ends up visible and on a screen, 1 when the slot's browser or its window does not
# exist yet, 2 when a window still is not.
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
    public static List<IntPtr> WindowsOf(uint processId) {
        var found = new List<IntPtr>();
        EnumWindows((hwnd, lParam) => { uint owner; GetWindowThreadProcessId(hwnd, out owner); if (owner == processId) found.Add(hwnd); return true; }, IntPtr.Zero);
        return found;
    }
}
'@

$N = [ShowChromium]
$SWP_NOSIZE = 0x0001; $SWP_NOMOVE = 0x0002; $SWP_NOZORDER = 0x0004; $SWP_NOACTIVATE = 0x0010; $SWP_SHOWWINDOW = 0x0040
$HWND_BOTTOM = [IntPtr]1
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

# A minimized window reports its icon's place, off every screen, so it is left out entirely.
$open = @($frames | Where-Object { -not $N::IsIconic($_) })

foreach ($hwnd in $open | Where-Object { -not $N::IsWindowVisible($_) }) {
    [void]$N::SetWindowPos($hwnd, $HWND_BOTTOM, 0, 0, 0, 0,
        $SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_NOACTIVATE -bor $SWP_SHOWWINDOW)
}

$work = (& {
    $info = New-Object ShowChromium+MonitorInfo
    $info.Size = [Runtime.InteropServices.Marshal]::SizeOf($info)
    [void]$N::GetMonitorInfo($N::MonitorFromPoint(0, $MONITOR_DEFAULTTOPRIMARY), [ref]$info)
    $info
}).Work

foreach ($hwnd in $open | Where-Object { -not (& $onScreen $_) }) {
    $rect = New-Object ShowChromium+Rect
    [void]$N::GetWindowRect($hwnd, [ref]$rect)
    $width = [Math]::Min($rect.Right - $rect.Left, $work.Right - $work.Left)
    $height = [Math]::Min($rect.Bottom - $rect.Top, $work.Bottom - $work.Top)
    [void]$N::SetWindowPos($hwnd, [IntPtr]::Zero, $work.Left, $work.Top, $width, $height, $SWP_NOZORDER -bor $SWP_NOACTIVATE)
}

$browser.ProcessId

if ($open | Where-Object { -not $N::IsWindowVisible($_) -or -not (& $onScreen $_) }) { exit 2 }
