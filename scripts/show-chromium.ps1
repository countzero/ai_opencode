# Shows the browser windows of one slot's chrome-devtools Chromium without activating them,
# for plugins/show-chromium.js. The caller was started hidden, so its first ShowWindow would be
# turned into SW_HIDE; SetWindowPos with SWP_SHOWWINDOW is not subject to that rule.
# Adapted from fertilizer_management's .claude/skills/chrome-devtools/scripts/show_window.ps1.
param([Parameter(Mandatory)][ValidatePattern('^\d+$')][string] $Slot)

Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class ShowChromium {
    public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    public static List<IntPtr> WindowsOf(uint processId) {
        var found = new List<IntPtr>();
        EnumWindows((hwnd, lParam) => { uint owner; GetWindowThreadProcessId(hwnd, out owner); if (owner == processId) found.Add(hwnd); return true; }, IntPtr.Zero);
        return found;
    }
}
'@

# The browser process: this exact profile, and no --type=, which every child process carries.
$pattern = '--user-data-dir="?[^"]*[\\/]chrome-devtools-mcp[\\/]opencode-profile-' + $Slot + '(?=["\s]|$)'
$browser = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
    Where-Object { $_.CommandLine -match $pattern -and $_.CommandLine -notmatch '--type=' } |
    Select-Object -First 1

if (-not $browser) { exit 1 }

foreach ($hwnd in [ShowChromium]::WindowsOf($browser.ProcessId)) {
    $class = [Text.StringBuilder]::new(64)
    [void][ShowChromium]::GetClassName($hwnd, $class, 64)

    # Browser frames only: menus, popups and bubbles lack a caption (WS_CAPTION) or have an owner.
    if ($class.ToString() -eq 'Chrome_WidgetWin_1' -and
        ([ShowChromium]::GetWindowLong($hwnd, -16) -band 0x00C00000) -eq 0x00C00000 -and
        [ShowChromium]::GetWindow($hwnd, 4) -eq [IntPtr]::Zero) {
        # SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW
        [void][ShowChromium]::SetWindowPos($hwnd, [IntPtr]::Zero, 0, 0, 0, 0, 0x57)
    }
}
