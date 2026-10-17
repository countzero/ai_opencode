#Requires -Version 7
<#
.SYNOPSIS
Moves this machine from OpenCode 1.x to 2.0, or back with -Rollback.

.DESCRIPTION
Runs from a checkout of this configuration's 2.0 branch, after every OpenCode window is
closed; it refuses otherwise. It:

  1. Copies the 1.x data to -BackupDir, because the first 2.0 start converts the
     database in place.
  2. Replaces opencode-ai with @opencode/cli@2. Both install the opencode command, so
     the old one goes first, together with its plugin cache.
  3. Disables the shared service, so every window runs a private server that inherits
     the window's CHROME_SLOT.
  4. Installs every npm plugin named in opencode.json in the foreground: left to
     startup, a first install can outlast the 5 s plugins get to activate, and every
     start then fails with "Location plugins did not finish activating".
  5. Drops the OPENCODE_EXPERIMENTAL_* lines 2.0 no longer reads from the PowerShell
     profile and adds the launcher function; the profile is backed up first.
  6. Checks that OpenCode 2 starts with every plugin activated.

Every step checks its own state, so a rerun after a failure skips what is done. The log
goes to the system temp directory.

-Rollback reinstalls opencode-ai@1, restores the data backup and the profile, and checks
out -LegacyBranch last, which removes this script from the checkout.

.EXAMPLE
& "$HOME\.config\opencode\scripts\migrate.ps1"

.EXAMPLE
& "$HOME\.config\opencode\scripts\migrate.ps1" -BackupDir E:\Backup\opencode-1.x

.EXAMPLE
& "$HOME\.config\opencode\scripts\migrate.ps1" -Rollback
#>
[CmdletBinding()]
param(
    [switch] $Rollback,

    # Skips the confirmation prompt.
    [switch] $Yes,

    [string] $BackupDir = (Join-Path $HOME '.local\share\opencode-1.x-backup'),

    [string] $ProfilePath = $PROFILE.CurrentUserAllHosts,

    # Its npm, not whichever an active conda environment puts first on Path.
    [string] $NodeDir = 'C:\Program Files\nodejs',

    [string] $LegacyBranch = 'main'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$config = Split-Path $PSScriptRoot
$data = Join-Path $HOME '.local\share\opencode'
$cache = Join-Path $HOME '.cache\opencode'
$profileBackup = "$ProfilePath.pre-opencode-2.bak"
$backupMarker = Join-Path $BackupDir 'backup-complete.txt'
$npm = Join-Path $NodeDir 'npm.cmd'
$obsoleteFlags = 'OPENCODE_EXPERIMENTAL_(CODE_MODE|OUTPUT_TOKEN_MAX|BACKGROUND_SUBAGENTS)'
$launcher = 'function opencode { & "$HOME\.config\opencode\scripts\opencode.ps1" @args }'
$log = Join-Path ([IO.Path]::GetTempPath()) 'opencode-migrate.log'

function Step([string] $title) {
    Write-Host "`n== $title" -ForegroundColor Cyan
}

function Info([string] $text) {
    Write-Host "   $text"
}

# Native commands report failure only through the exit code.
function Invoke-Checked([string] $command, [string[]] $arguments) {
    & $command @arguments

    if ($LASTEXITCODE -ne 0) {
        throw "$command $($arguments -join ' ') failed (exit code $LASTEXITCODE)."
    }
}

function Invoke-Robocopy([string] $from, [string] $to, [string[]] $extra = @()) {
    robocopy $from $to /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NP /NJH @extra | Out-Host

    # Robocopy exit codes below 8 mean success.
    if ($LASTEXITCODE -ge 8) {
        throw "robocopy $from -> $to failed (exit code $LASTEXITCODE)."
    }
}

function Get-GlobalPackages {
    $tree = & $npm ls -g --depth=0 --json 2>$null | ConvertFrom-Json

    if ($tree -and $tree.PSObject.Properties['dependencies']) {
        return @($tree.dependencies.PSObject.Properties.Name)
    }

    return @()
}

# opencode.json is JSONC with trailing commas, which ConvertFrom-Json rejects.
function Get-NpmPlugins {
    $json = Get-Content (Join-Path $config 'opencode.json') -Raw
    $list = [regex]::Match($json, '"plugins"\s*:\s*\[(?<items>[^\]]*)\]').Groups['items'].Value

    return @([regex]::Matches($list, '"([^"]+)"') |
        ForEach-Object { $_.Groups[1].Value } |
        Where-Object { $_ -notmatch '^(\.|/|[A-Za-z]:|file:)' })
}

function Assert-Preflight {
    if ($env:OPENCODE) {
        throw 'This shell runs inside OpenCode. Close every OpenCode window and run the script from a new pwsh window.'
    }

    if (-not (Test-Path $npm)) {
        throw "npm not found at $npm; pass -NodeDir."
    }

    $processes = @(Get-CimInstance Win32_Process -Filter "Name LIKE 'opencode%'")
    $windows = @($processes | Where-Object { $_.CommandLine -notmatch '\bserve\b' })

    if ($windows) {
        throw "OpenCode is still running (PID $($windows.ProcessId -join ', ')). Close every OpenCode window first."
    }

    # The shared 2.0 service outlives its windows and holds opencode.exe, which npm replaces.
    $servers = @($processes | Where-Object { $_.CommandLine -match '\bserve\b' })

    if ($servers) {
        if (Test-Path $opencode) {
            & $opencode service stop 2>$null | Out-Null
            Start-Sleep -Seconds 2
        }

        Get-Process -Id $servers.ProcessId -ErrorAction Ignore | Stop-Process -Force
        Info "Stopped the OpenCode service (PID $($servers.ProcessId -join ', '))."
    }

    if (git -C $config status --porcelain) {
        throw "$config has uncommitted changes; commit or stash them first."
    }
}

function Update-Profile {
    if (-not (Test-Path $ProfilePath)) {
        New-Item -ItemType File -Force $ProfilePath | Out-Null
    }

    $bytes = [IO.File]::ReadAllBytes($ProfilePath)
    $bom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    $text = [IO.File]::ReadAllText($ProfilePath)
    $newline = if ($text -match "`r`n") { "`r`n" } else { "`n" }
    $lines = [regex]::Split($text, '\r?\n')

    $isFlag = { param($line) $line -match $obsoleteFlags -and $line -notmatch '^\s*#' }
    $removed = @($lines | Where-Object { & $isFlag $_ })
    $kept = [Collections.Generic.List[string]] @($lines | Where-Object { -not (& $isFlag $_) })
    $hasLauncher = [bool] ($kept | Where-Object { $_ -match '^\s*function\s+opencode\b' })

    if (-not $removed -and $hasLauncher) {
        Info 'Already up to date.'

        return
    }

    if (-not (Test-Path $profileBackup)) {
        Copy-Item $ProfilePath $profileBackup
        Info "Backed up to $profileBackup."
    }

    if (-not $hasLauncher) {
        # Before the empty element a trailing newline leaves, so the file still ends in one.
        $at = if ($kept.Count -and $kept[$kept.Count - 1] -eq '') { $kept.Count - 1 } else { $kept.Count }
        $kept.InsertRange($at, [string[]] @('', '# OpenCode 2.0: one Chrome slot per window (~/.config/opencode/scripts/opencode.ps1).', $launcher))
        Info 'Added the launcher function.'
    }

    [IO.File]::WriteAllText($ProfilePath, ($kept -join $newline), [Text.UTF8Encoding]::new($bom))

    foreach ($line in $removed) {
        Info "Removed: $($line.Trim())"
    }

    foreach ($line in $kept | Where-Object { $_ -match $obsoleteFlags }) {
        Write-Warning "Comment left in the profile; delete it by hand: $($line.Trim())"
    }
}

function Invoke-Migration {
    Step "Data: back up 1.x to $BackupDir"

    if (Test-Path $backupMarker) {
        Info 'A complete backup exists; kept.'
    } elseif ((Get-GlobalPackages) -contains '@opencode/cli') {
        throw "@opencode/cli is already installed, so $data may hold 2.0 data; refusing to back it up as 1.x."
    } else {
        $size = (Get-ChildItem $data -Recurse -File -Force | Measure-Object Length -Sum).Sum
        $drive = Get-PSDrive ([IO.Path]::GetPathRoot($BackupDir).Substring(0, 1))

        if ($drive.Free -lt $size * 1.1) {
            throw ('The backup needs {0:N1} GB, {1}: has {2:N1} GB free; pass -BackupDir on another drive.' -f ($size / 1GB), $drive.Name, ($drive.Free / 1GB))
        }

        Info ('Copying {0:N1} GB ...' -f ($size / 1GB))
        Invoke-Robocopy $data $BackupDir
        Set-Content $backupMarker "Copy of $data taken $(Get-Date -Format o) before migrating to OpenCode 2.0."
    }

    Step 'OpenCode: replace opencode-ai 1.x with @opencode/cli 2'

    $stale = @(Get-GlobalPackages | Where-Object { $_ -in 'opencode-ai', 'opencode-claude-auth' })

    if ($stale) {
        if (Test-Path $cache) {
            Remove-Item -Recurse -Force $cache
            Info "Removed the 1.x cache $cache."
        }

        Invoke-Checked $npm (@('-g', 'uninstall') + $stale)
    }

    if ((Get-GlobalPackages) -notcontains '@opencode/cli') {
        Invoke-Checked $npm @('-g', 'install', '--no-fund', '--no-audit', '@opencode/cli@2')
    }

    # Prints "opencode v2.0.32".
    $version = "$(& $opencode --version)".Trim()

    if ($version -notmatch '\bv?2\.\d') {
        throw "opencode --version reports '$version', expected 2.x."
    }

    Info "Installed: $version."

    Step 'OpenCode: disable the shared service, install the plugins'

    Invoke-Checked $opencode @('service', 'set', 'disabled', 'true')

    foreach ($plugin in Get-NpmPlugins) {
        Info "Installing $plugin; a first install can take a minute ..."
        Invoke-Checked $opencode @('plugin', 'add', $plugin)
    }

    Step "PowerShell profile: $ProfilePath"
    Update-Profile

    Step 'Verify'

    Info "service: $("$(& $opencode service status)".Trim())"
    Push-Location $config

    try {
        $models = @(& $opencode models 2>&1)
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }

    if ($code -ne 0) {
        throw "opencode models failed, so a plugin did not activate: $(($models | Select-Object -Last 3) -join ' ')"
    }

    Info "opencode models: $($models.Count) models, every plugin activated."
}

function Invoke-Rollback {
    Step 'OpenCode: replace @opencode/cli with opencode-ai 1.x'

    if ((Get-GlobalPackages) -contains '@opencode/cli') {
        & $opencode service stop 2>$null | Out-Null
        Invoke-Checked $npm @('-g', 'uninstall', '@opencode/cli')
    }

    if (Test-Path $cache) {
        Remove-Item -Recurse -Force $cache
        Info "Removed the 2.0 cache $cache."
    }

    Invoke-Checked $npm @('-g', 'install', '--no-fund', '--no-audit', 'opencode-ai@1')

    Step "Data: restore $BackupDir"

    if (-not (Test-Path $backupMarker)) {
        throw "No complete backup in $BackupDir; pass the -BackupDir the migration used."
    }

    if (Test-Path $data) {
        # Kept, not deleted: it holds every session made in 2.0.
        $aside = "$data.2.0-$(Get-Date -Format yyyyMMdd-HHmmss)"
        Rename-Item $data (Split-Path $aside -Leaf)
        Info "Moved the 2.0 data aside to $aside."
    }

    Invoke-Robocopy $BackupDir $data @('/XF', (Split-Path $backupMarker -Leaf))

    Step "PowerShell profile: $ProfilePath"

    if (Test-Path $profileBackup) {
        Copy-Item $profileBackup $ProfilePath -Force
        Info "Restored from $profileBackup."
    } else {
        Info 'No profile backup; unchanged.'
    }

    # Last: the checkout removes this script.
    Step "Config repository: check out $LegacyBranch"
    Invoke-Checked git @('-C', $config, 'checkout', '--quiet', $LegacyBranch)
}

$npmPrefix = if (Test-Path $npm) { "$(& $npm prefix -g)".Trim() } else { Join-Path $env:APPDATA 'npm' }
$opencode = Join-Path $npmPrefix 'opencode.cmd'
$env:Path = "$NodeDir;$npmPrefix;$env:Path"

try {
    Assert-Preflight
} catch {
    Write-Host "STOPPED: $($_.Exception.Message)" -ForegroundColor Red

    exit 1
}

$action = if ($Rollback) { 'roll this machine back to OpenCode 1.x' } else { 'migrate this machine to OpenCode 2.0' }

if (-not $Yes -and (Read-Host "This will $action. Type yes to continue") -ne 'yes') {
    return
}

Start-Transcript -Path $log -Append | Out-Null

try {
    if ($Rollback) {
        Invoke-Rollback
    } else {
        Invoke-Migration
    }
} catch {
    Write-Host "`nFAILED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Fix the cause and run the script again; finished steps are skipped. Log: $log"
    Stop-Transcript | Out-Null

    exit 1
}

Stop-Transcript | Out-Null

if ($Rollback) {
    Write-Host "`nRolled back. Open a new terminal and start opencode." -ForegroundColor Green
} else {
    Write-Host "`nMigrated. Open a new terminal and follow MIGRATION.md from step 2: log in." -ForegroundColor Green
}
