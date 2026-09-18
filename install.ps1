# Ledgr one-file installer for Windows (LH4, ADR-206 decision 10).
#
# The only file a brand-new machine downloads. It gets the machine to "repo
# cloned, dependencies installed", then hands off to the cross-platform Node
# wizard (scripts/local-setup.mjs), which does everything else: hub-or-spoke,
# restore-or-join, config, service registration. Keep this script dumb on
# purpose — logic added here would need re-doing for install.sh, while logic
# in the wizard is already the Linux story.
#
# Idempotent: re-running pulls the existing clone instead of recloning, winget
# skips what is installed, npm ci is repeatable, and the wizard refuses to
# clobber its config without --force.
#
# No secrets live here and none are asked for; the wizard collects tokens at
# runtime. No admin elevation is required by this script itself; winget MAY
# prompt for elevation (UAC) while installing Git or Node system-wide.
#
# Usage:
#   Double-click install.cmd — the file to actually download. Windows won't
#   run a .ps1 on double-click (it opens an editor instead); install.cmd is
#   the tiny batch wrapper that runs this script and keeps the window open.
#
#   Or from PowerShell directly (5.1+):
#     powershell -ExecutionPolicy Bypass -File install.ps1
#     powershell -ExecutionPolicy Bypass -File install.ps1 -InstallDir C:\ledgr

param(
    [string]$InstallDir = "$env:LOCALAPPDATA\Ledgr\app",
    # Everything after -- lands here and is forwarded to the setup wizard, so
    # flags like --force stay reachable from the double-click entry point.
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$WizardArgs = @()
)

$ErrorActionPreference = "Stop"
$RepoUrl = "https://github.com/strategicli/ledgr"

function Test-Cmd([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# Install a prerequisite through winget, or say exactly what to do by hand
# when winget itself is missing (older Windows 10 images ship without it).
# $Fatal = $false makes a missing tool a warning instead of a stop: used for
# the Postgres client tools below, since "start empty" never needs them.
function Ensure-Tool([string]$Cmd, [string]$WingetId, [string]$ManualUrl, [bool]$Fatal = $true) {
    if (Test-Cmd $Cmd) {
        Write-Host "$Cmd found."
        return
    }
    if (-not (Test-Cmd "winget")) {
        Write-Host ""
        Write-Host "winget is not available, so $Cmd cannot be installed automatically."
        Write-Host "Install it manually from $ManualUrl , then re-run this script."
        if ($Fatal) { exit 1 } else { return }
    }
    Write-Host "Installing $Cmd (winget $WingetId; a UAC prompt may appear)..."
    winget install --id $WingetId -e --accept-source-agreements --accept-package-agreements
    # The current session's PATH predates the install; splice in the machine
    # and user PATH so git/node resolve without opening a new terminal.
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not (Test-Cmd $Cmd)) {
        if ($Fatal) {
            Write-Host "$Cmd still is not on PATH. Open a NEW PowerShell window and re-run this script."
            exit 1
        }
        Write-Host "$Cmd still is not on PATH; continuing without it (see the warning below)."
    }
}

Ensure-Tool "git" "Git.Git" "https://git-scm.com/download/win"
Ensure-Tool "node" "OpenJS.NodeJS.LTS" "https://nodejs.org"
# Two things need the Postgres client tools, and the embedded-postgres package
# ships the SERVER only (postgres/initdb/pg_ctl and nothing else), so they are a
# real dependency rather than a nicety:
#
#   • restoring from a BACKUP FILE (npm run local:restore), which needs pg_restore
#   • local SNAPSHOTS (ADR-217), which need pg_dump to take one and pg_restore to
#     open one — the hourly restore points on Build → Updates
#
# Still non-fatal: the live database pull is native (scripts/lib/pg-copy.mjs
# copies rows with the `pg` driver the app already ships), starting empty needs
# neither, and snapshots are off by default. Don't block a working install on a
# tool the chosen path doesn't use; say clearly what is given up instead.
#
# Unlike Git and Node, the PostgreSQL Windows installer does NOT add itself to
# PATH — that gap, not a missing install, is what broke the first real
# install (pg_restore was on disk but unresolvable). Ensure-Tool's PATH splice
# only covers a FRESH winget install; find the client tools' bin folder below
# so an install from before this fix (or a manual installer run) still works.
Ensure-Tool "pg_restore" "PostgreSQL.PostgreSQL.18" "https://www.postgresql.org/download/windows/" $false
if (-not (Test-Cmd "pg_restore")) {
    $pgBin = Get-ChildItem "C:\Program Files\PostgreSQL" -Directory -ErrorAction SilentlyContinue |
        Sort-Object { [int]$_.Name } -Descending |
        ForEach-Object { Join-Path $_.FullName "bin" } |
        Where-Object { Test-Path (Join-Path $_ "pg_restore.exe") } |
        Select-Object -First 1
    if ($pgBin) {
        Write-Host "Found the Postgres client tools at $pgBin (not on PATH this session) - using them directly."
        $env:Path = "$pgBin;$env:Path"
    }
}
if (-not (Test-Cmd "pg_restore")) {
    Write-Host "Warning: the Postgres client tools were not found. The live database pull needs no extra tools, so setup continues - but two things stay unavailable until you install them (winget install PostgreSQL.PostgreSQL.18): restoring from a backup FILE, and local snapshots (the hourly restore points on Build - Updates)."
}

# Clone fresh, or bring an existing clone current. --ff-only so a locally
# diverged clone fails loudly instead of merging silently.
if (Test-Path (Join-Path $InstallDir ".git")) {
    Write-Host "Existing clone at $InstallDir - pulling..."
    git -C $InstallDir pull --ff-only
    if ($LASTEXITCODE -ne 0) { Write-Host "git pull failed (local changes?). Fix the clone, then re-run."; exit 1 }
} else {
    Write-Host "Cloning into $InstallDir..."
    New-Item -ItemType Directory -Force -Path (Split-Path $InstallDir -Parent) | Out-Null
    git clone $RepoUrl $InstallDir
    if ($LASTEXITCODE -ne 0) { Write-Host "git clone failed."; exit 1 }
}

Set-Location $InstallDir
Write-Host "Installing dependencies (npm ci; this fetches the embedded Postgres binaries)..."
npm ci
if ($LASTEXITCODE -ne 0) { Write-Host "npm ci failed."; exit 1 }

# Everything from here is shared cross-platform Node code: the wizard asks
# hub-or-spoke, restores or seeds the data, writes supervisor/config.json,
# and offers Task Scheduler registration.
#
# Anything after -- on our own command line is forwarded to the wizard, so a
# double-click user is not cut off from its flags: install.cmd -- --force,
# for instance. The wizard also ASKS before overwriting an existing config
# when it has a terminal, so a plain re-run works without any flag at all.
node scripts\local-setup.mjs @WizardArgs
exit $LASTEXITCODE
