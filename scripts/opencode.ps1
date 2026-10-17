# Starts OpenCode with a chrome-devtools MCP profile of its own: the lowest slot no other
# running window holds, handed down as CHROME_SLOT, which opencode.json writes into the
# MCP's --userDataDir as {env:CHROME_SLOT}. With the shared service disabled, every window
# runs a private server that inherits this environment, so one window is one slot.
#
# Holding a named pipe is the claim. Creating a pipe server limited to one instance is
# atomic, so two launches racing for a slot cannot both win, and the OS frees the pipe when
# this process ends, however it ends, so a crashed window never strands its slot.
#
# A CHROME_SLOT already in the environment is only a preference, claimed like any other
# slot and passed over when taken: a taken profile could not start Chrome anyway, and an
# OpenCode started from an agent shell inherits its parent's CHROME_SLOT, so it needs one
# of its own.
#
# When every slot is taken, OpenCode still starts, with a warning and without CHROME_SLOT;
# {env:CHROME_SLOT} then resolves empty, so the MCP profile is the shared opencode-profile-.
#
# OpenCode runs through npm's opencode.cmd by full path: a bare `opencode` would hit the
# profile function that calls this script and recurse, and the opencode.ps1 shim ends with
# `exit`, which would skip the cleanup below.
#
# Install: in the PowerShell profile,
#
#   function opencode { & "$HOME\.config\opencode\scripts\opencode.ps1" @args }

# Bounds the scan; no machine runs this many windows.
$slotCeiling = 1000

$executable = Join-Path $env:APPDATA 'npm\opencode.cmd'

# The profile function runs this in the caller's session, whose CHROME_SLOT must survive.
$previous = $env:CHROME_SLOT
$pipe = $null
$exitCode = 1

$claim = {
    param([int] $slot)

    try {
        [System.IO.Pipes.NamedPipeServerStream]::new("opencode-chrome-slot-$slot", [System.IO.Pipes.PipeDirection]::InOut, 1)
    } catch [System.IO.IOException], [System.UnauthorizedAccessException] {
        # Held by another window, or by another user's process: taken either way.
        $null
    }
}

try {
    $preferred = "$previous".Trim()

    if ($preferred -match '^\d{1,3}$') {
        $slot = [int] $preferred
        $pipe = & $claim $slot
    }

    for ($candidate = 0; -not $pipe -and $candidate -lt $slotCeiling; $candidate++) {
        $slot = $candidate
        $pipe = & $claim $slot
    }

    if ($pipe) {
        $env:CHROME_SLOT = "$slot"
    } else {
        Remove-Item Env:CHROME_SLOT -ErrorAction Ignore
        Write-Warning "All $slotCeiling Chrome slots are taken; chrome-devtools falls back to the shared opencode-profile-."
    }

    & $executable @args
    $exitCode = $LASTEXITCODE
} finally {
    # Also runs on Ctrl+C, which reaches OpenCode first and then stops this script.
    if ($pipe) {
        $pipe.Dispose()
    }

    if ($null -eq $previous) {
        Remove-Item Env:CHROME_SLOT -ErrorAction Ignore
    } else {
        $env:CHROME_SLOT = $previous
    }
}

exit $exitCode
