# The notification-area icon for a local Ledgr peer.
#
# Why it exists: the local service is a background process with no window, so
# until now the only way to know whether Ledgr was running was to open Ledgr —
# which tells you nothing when the answer is "it isn't". This is the surface
# that still works when the app is down: a dot near the clock, coloured by what
# is actually answering, and a right-click menu that can start, restart and stop
# the peer without a terminal.
#
# "Ledgr status..." opens a real window (a WinForms Form, one instance at a
# time — reopening the menu item just brings the existing one to front) with
# two tabs: STATUS (read-only: run state, build version, update policy, disk
# use per data folder, the scheduled-jobs table, and sync role) and SETTINGS
# (the only thing it can write: $DataDir\update-policy.json — auto-check
# cadence, branch, repo). It replaces the old "Check status" balloon, which
# Windows 11 quietly swallows, so clicking it looked like it did nothing.
#
# Written in PowerShell against WinForms on purpose. Windows ships both, so a
# permanently-running tray icon costs this project no new dependency (principle
# 5) and nothing to maintain when Node moves.
#
# It does not supervise anything. It watches two ports and reads a handful of
# JSON files the service already writes, and shells out to ledgr-ctl for every
# start/stop/restart action, so nothing here can disagree with the CLI. The
# status window's only write path is update-policy.json, and only because the
# service already reads that file on its own schedule — the window never
# touches config.json and never restarts anything to make a setting take
# effect.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden \
#     -File ledgr-tray.ps1 -NodePath ... -CtlScript ... -ConfigPath ...
#
# Started and installed by `npm run local:tray`; see ledgr-ctl.mjs doTray.
param(
  [Parameter(Mandatory = $true)][string]$NodePath,
  [Parameter(Mandatory = $true)][string]$CtlScript,
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [int]$AppPort = 3000,
  [int]$DbPort = 5433,
  [string]$DataDir = "",
  [int]$PollSeconds = 15
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ── State detection ──────────────────────────────────────────────────────────
#
# Two TCP probes, no child processes, because this runs every few seconds
# forever. The app port answering is the only thing that means "Ledgr works";
# the database port answering on its own means the peer is mid-start or the app
# has fallen over, which is worth a different colour from plain "down".

function Test-Port([int]$Port, [int]$TimeoutMs = 700) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Get-PeerState {
  if (Test-Port $AppPort) { return "serving" }
  if (Test-Port $DbPort) { return "starting" }
  return "down"
}

function Get-BuildSha {
  if (-not $DataDir) { return "" }
  $p = Join-Path $DataDir "live.json"
  if (-not (Test-Path $p)) { return "" }
  try {
    $sha = (Get-Content $p -Raw | ConvertFrom-Json).sha
    if ($sha) { return $sha.Substring(0, 7) }
  } catch { }
  return ""
}

# Reads $DataDir\live.json in full (sha + flippedAt); returns $null if absent
# or unreadable, so callers can show "unknown" rather than a wrong guess.
function Get-LiveInfo {
  if (-not $DataDir) { return $null }
  $p = Join-Path $DataDir "live.json"
  if (-not (Test-Path $p)) { return $null }
  try { return (Get-Content $p -Raw | ConvertFrom-Json) } catch { return $null }
}

# "6 h ago" / "3 d ago" / "just now" from an ISO 8601 timestamp. Deliberately
# coarse — this is a glance, not a log.
function Format-Ago([string]$IsoTime) {
  if (-not $IsoTime) { return "unknown" }
  try {
    $then = [DateTime]::Parse($IsoTime, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind)
  } catch {
    return "unknown"
  }
  $span = (Get-Date).ToUniversalTime() - $then.ToUniversalTime()
  if ($span.TotalSeconds -lt 0) { return "just now" }
  if ($span.TotalMinutes -lt 1) { return "just now" }
  if ($span.TotalMinutes -lt 60) { return "{0:N0} min ago" -f $span.TotalMinutes }
  if ($span.TotalHours -lt 24) { return "{0:N0} h ago" -f $span.TotalHours }
  return "{0:N0} d ago" -f $span.TotalDays
}

# KB/MB/GB from a byte count. Anything under 1 KB just reads as "0 KB" — nobody
# tracking disk use for a Postgres data directory cares about single bytes.
function Format-Bytes([long]$Bytes) {
  if ($Bytes -ge 1GB) { return "{0:N1} GB" -f ($Bytes / 1GB) }
  if ($Bytes -ge 1MB) { return "{0:N1} MB" -f ($Bytes / 1MB) }
  return "{0:N0} KB" -f ($Bytes / 1KB)
}

# Size of a directory tree, in bytes. robocopy's /L (list-only) + /BYTES walk
# is far faster than Get-ChildItem -Recurse on a node_modules-heavy folder
# (builds\*), because it never opens a WinForms/PowerShell object per file.
# Falls back to Get-ChildItem when robocopy is missing (non-Windows PowerShell
# Core installs sometimes lack it) or a size can't be parsed.
function Get-DirBytes([string]$Path) {
  if (-not (Test-Path $Path)) { return 0 }
  $robocopy = Get-Command "robocopy.exe" -ErrorAction SilentlyContinue
  if ($robocopy) {
    try {
      $out = & robocopy.exe $Path $Path /L /S /NFL /NDL /NJH /NP /BYTES /XJ 2>$null
      $line = $out | Where-Object { $_ -match "Bytes\s*:\s*([\d,]+)" } | Select-Object -Last 1
      if ($line -and $line -match "Bytes\s*:\s*([\d,]+)") {
        return [long]($Matches[1] -replace ",", "")
      }
    } catch { }
  }
  try {
    return (Get-ChildItem $Path -Recurse -Force -File -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum).Sum
  } catch {
    return 0
  }
}

# ── Icons ────────────────────────────────────────────────────────────────────
#
# Drawn once and reused. GetHicon allocates an unmanaged handle every call, so
# building these inside the timer would leak one icon handle every poll.

function New-DotIcon([System.Drawing.Color]$Color) {
  $bmp = New-Object System.Drawing.Bitmap 16, 16
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $brush = New-Object System.Drawing.SolidBrush $Color
  $g.FillEllipse($brush, 2, 2, 12, 12)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(90, 0, 0, 0)), 1
  $g.DrawEllipse($pen, 2, 2, 12, 12)
  $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  $brush.Dispose(); $pen.Dispose(); $g.Dispose(); $bmp.Dispose()
  return $icon
}

$icons = @{
  serving  = New-DotIcon ([System.Drawing.Color]::FromArgb(34, 170, 85))
  starting = New-DotIcon ([System.Drawing.Color]::FromArgb(220, 160, 40))
  down     = New-DotIcon ([System.Drawing.Color]::FromArgb(210, 60, 60))
}
$labels = @{
  serving  = "Ledgr is running"
  starting = "Ledgr is starting (the app is not answering yet)"
  down     = "Ledgr is NOT running"
}

# ── Actions ──────────────────────────────────────────────────────────────────
#
# Every action is the CLI verb, run hidden and NOT waited on: a restart takes
# the better part of a minute and a frozen tray icon during it would read as a
# crash. The poll below is what reports the result, which also means the icon
# can never claim an outcome the ports do not agree with.

function Invoke-Ctl([string]$Verb) {
  Start-Process -FilePath $NodePath `
    -ArgumentList @($CtlScript, $Verb, "--config=$ConfigPath") `
    -WindowStyle Hidden | Out-Null
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $icons["down"]
$notify.Text = "Ledgr"
$notify.Visible = $true

function Show-Balloon([string]$Title, [string]$Body) {
  $notify.BalloonTipTitle = $Title
  $notify.BalloonTipText = $Body
  $notify.ShowBalloonTip(5000)
}

# ── Status window ────────────────────────────────────────────────────────────
#
# One instance at a time. Windows 11 silently drops balloon tips from
# PowerShell, which made "Check status" look like a dead menu item; a real
# Form always shows something. Read-only STATUS tab, single-file-write
# SETTINGS tab — see the header comment for the boundary.

$script:statusForm = $null

function Read-JsonFile([string]$Path) {
  if (-not (Test-Path $Path)) { return $null }
  try { return (Get-Content $Path -Raw | ConvertFrom-Json) } catch { return $null }
}

function Get-EveryText($Job) {
  if ($Job.at) { return "daily at $($Job.at)" }
  $m = $Job.everyMinutes
  if (-not $m) { return "unknown" }
  if ($m -ge 60 -and ($m % 60) -eq 0) {
    $h = $m / 60
    if ($h -eq 1) { return "hourly" }
    return "every $h hours"
  }
  return "every $m min"
}

# WHY `$script:` EVERYWHERE BELOW. WinForms fires event handlers on the message
# loop, in SCRIPT scope, not inside the function that built the form. A handler
# that names a function-local control finds $null, and a function nested inside
# New-StatusForm does not exist at all from there ("The term 'Load-Policy' is not
# recognized", 2026-09-12). So every control a handler touches is script-scoped,
# and the two refreshers are top-level functions.

function Load-Policy {
  $p = Read-JsonFile $script:policyPath
  if ($p) {
    if ($p.mode -eq "manual") { $script:radioManual.Checked = $true } else { $script:radioAuto.Checked = $true }
    if ($p.everyMinutes) { $script:numEvery.Value = [Math]::Min([Math]::Max([int]$p.everyMinutes, 1), 1440) }
    $script:txtBranch.Text = if ($p.branch) { $p.branch } else { "main" }
    $script:txtRepo.Text = if ($p.repo) { $p.repo } else { "" }
  } else {
    $script:radioAuto.Checked = $true
    $script:numEvery.Value = 15
    $script:txtBranch.Text = "main"
    $script:txtRepo.Text = ""
  }
  $script:numEvery.Enabled = $script:radioAuto.Checked
  $script:lblSaved.Text = ""
}

function Refresh-Status {
  $state = Get-PeerState
  $stateText = switch ($state) { "serving" { "Running" } "starting" { "Starting" } default { "Not running" } }
  $script:lblState.Text = "State: $stateText  (app port $AppPort, db port $DbPort)"

  $live = Get-LiveInfo
  if ($live -and $live.sha) {
    $sha7 = $live.sha.Substring(0, [Math]::Min(7, $live.sha.Length))
    $script:lblVersion.Text = "Version: $sha7 - Updated $(Format-Ago $live.flippedAt)"
  } else {
    $script:lblVersion.Text = "Version: unknown"
  }

  $policy = if ($DataDir) { Read-JsonFile (Join-Path $DataDir "update-policy.json") } else { $null }
  if (-not $policy) {
    $script:lblUpdate.Text = "Updates: no update policy written yet (the service writes one on its first start)"
  } elseif ($policy.mode -eq "manual") {
    $script:lblUpdate.Text = "Updates: only when you press Update now in Ledgr (branch $($policy.branch))"
  } else {
    $script:lblUpdate.Text = "Updates: checks every $($policy.everyMinutes) min on branch $($policy.branch)"
  }

  $cron = if ($DataDir) { Read-JsonFile (Join-Path $DataDir "cron-state.json") } else { $null }
  $script:listJobs.Items.Clear()
  if ($cron -and $cron.jobs) {
    foreach ($j in $cron.jobs) {
      $item = New-Object System.Windows.Forms.ListViewItem($j.label)
      $item.SubItems.Add((Get-EveryText $j)) | Out-Null
      $item.SubItems.Add((Format-Ago $j.lastOkAt)) | Out-Null
      $item.SubItems.Add($j.state) | Out-Null
      $script:listJobs.Items.Add($item) | Out-Null
    }
  } else {
    $item = New-Object System.Windows.Forms.ListViewItem("No record yet")
    $item.SubItems.Add(""); $item.SubItems.Add(""); $item.SubItems.Add("")
    $script:listJobs.Items.Add($item) | Out-Null
  }

  $config = Read-JsonFile $ConfigPath
  if ($config -and $config.role -eq "hub") {
    $script:lblSync.Text = "Sync: Role: hub"
  } elseif ($config -and $config.role -eq "spoke") {
    $n = if ($config.hubs) { @($config.hubs).Count } else { 0 }
    $script:lblSync.Text = "Sync: Role: spoke, syncing to $n hub(s)"
  } else {
    $script:lblSync.Text = "Sync: unknown"
  }
}

function New-StatusForm {
  $script:form = New-Object System.Windows.Forms.Form
  $script:form.Text = "Ledgr"
  $script:form.ClientSize = New-Object System.Drawing.Size 520, 560
  $script:form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $script:form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedSingle
  $script:form.MaximizeBox = $false
  $script:form.MinimizeBox = $true

  $tabs = New-Object System.Windows.Forms.TabControl
  $tabs.Dock = [System.Windows.Forms.DockStyle]::Fill
  $tabStatus = New-Object System.Windows.Forms.TabPage "Status"
  $tabSettings = New-Object System.Windows.Forms.TabPage "Settings"
  $tabs.TabPages.Add($tabStatus) | Out-Null
  $tabs.TabPages.Add($tabSettings) | Out-Null

  # -- Status tab --------------------------------------------------------------
  $script:lblState = New-Object System.Windows.Forms.Label
  $script:lblState.SetBounds(12, 12, 480, 20)
  $script:lblVersion = New-Object System.Windows.Forms.Label
  $script:lblVersion.SetBounds(12, 34, 480, 20)
  $script:lblUpdate = New-Object System.Windows.Forms.Label
  $script:lblUpdate.SetBounds(12, 56, 480, 20)

  $lblDiskHeader = New-Object System.Windows.Forms.Label
  $lblDiskHeader.SetBounds(12, 86, 200, 18)
  $lblDiskHeader.Text = "Disk use"
  $lblDiskHeader.Font = New-Object System.Drawing.Font($lblDiskHeader.Font, [System.Drawing.FontStyle]::Bold)
  $script:lblDisk = New-Object System.Windows.Forms.Label
  $script:lblDisk.SetBounds(12, 106, 480, 76)
  $script:lblDisk.Text = "measuring..."

  $lblJobsHeader = New-Object System.Windows.Forms.Label
  $lblJobsHeader.SetBounds(12, 190, 200, 18)
  $lblJobsHeader.Text = "Scheduled jobs"
  $lblJobsHeader.Font = New-Object System.Drawing.Font($lblJobsHeader.Font, [System.Drawing.FontStyle]::Bold)

  $script:listJobs = New-Object System.Windows.Forms.ListView
  $script:listJobs.SetBounds(12, 210, 480, 190)
  $script:listJobs.View = [System.Windows.Forms.View]::Details
  $script:listJobs.FullRowSelect = $true
  $script:listJobs.GridLines = $true
  $script:listJobs.Columns.Add("Job", 150) | Out-Null
  $script:listJobs.Columns.Add("Every", 110) | Out-Null
  $script:listJobs.Columns.Add("Last success", 110) | Out-Null
  $script:listJobs.Columns.Add("State", 90) | Out-Null

  $script:lblSync = New-Object System.Windows.Forms.Label
  $script:lblSync.SetBounds(12, 408, 480, 20)

  $btnOpen = New-Object System.Windows.Forms.Button
  $btnOpen.SetBounds(12, 480, 110, 28)
  $btnOpen.Text = "Open Ledgr"
  $btnOpen.add_Click({ Start-Process "http://localhost:$AppPort" })

  $btnData = New-Object System.Windows.Forms.Button
  $btnData.SetBounds(130, 480, 130, 28)
  $btnData.Text = "Open data folder"
  $btnData.add_Click({ if ($DataDir) { Start-Process "explorer.exe" $DataDir } })

  $btnLogs = New-Object System.Windows.Forms.Button
  $btnLogs.SetBounds(268, 480, 100, 28)
  $btnLogs.Text = "Open logs"
  $btnLogs.add_Click({
      if ($DataDir) { Start-Process "notepad.exe" (Join-Path $DataDir "supervisor.log") }
    })

  $btnClose = New-Object System.Windows.Forms.Button
  $btnClose.SetBounds(412, 480, 80, 28)
  $btnClose.Text = "Close"
  $btnClose.add_Click({ $script:form.Close() })

  $tabStatus.Controls.AddRange(@(
      $script:lblState, $script:lblVersion, $script:lblUpdate, $lblDiskHeader, $script:lblDisk,
      $lblJobsHeader, $script:listJobs, $script:lblSync, $btnOpen, $btnData, $btnLogs, $btnClose
    ))

  # -- Settings tab -------------------------------------------------------------
  $script:policyPath = if ($DataDir) { Join-Path $DataDir "update-policy.json" } else { "" }

  $script:radioAuto = New-Object System.Windows.Forms.RadioButton
  $script:radioAuto.SetBounds(12, 14, 220, 22)
  $script:radioAuto.Text = "Check for updates automatically"

  $lblEvery1 = New-Object System.Windows.Forms.Label
  $lblEvery1.SetBounds(32, 42, 40, 22)
  $lblEvery1.Text = "every"
  $script:numEvery = New-Object System.Windows.Forms.NumericUpDown
  $script:numEvery.SetBounds(74, 40, 70, 22)
  $script:numEvery.Minimum = 1
  $script:numEvery.Maximum = 1440
  $script:numEvery.Value = 15
  $lblEvery2 = New-Object System.Windows.Forms.Label
  $lblEvery2.SetBounds(150, 42, 80, 22)
  $lblEvery2.Text = "minutes"

  $script:radioManual = New-Object System.Windows.Forms.RadioButton
  $script:radioManual.SetBounds(12, 70, 400, 22)
  $script:radioManual.Text = "Only when I press Update now in Ledgr"

  $lblBranch = New-Object System.Windows.Forms.Label
  $lblBranch.SetBounds(12, 108, 480, 18)
  $lblBranch.Text = "Branch to follow"
  $script:txtBranch = New-Object System.Windows.Forms.TextBox
  $script:txtBranch.SetBounds(12, 128, 300, 22)

  $lblRepo = New-Object System.Windows.Forms.Label
  $lblRepo.SetBounds(12, 160, 480, 18)
  $lblRepo.Text = "Repository (git URL)"
  $script:txtRepo = New-Object System.Windows.Forms.TextBox
  $script:txtRepo.SetBounds(12, 180, 480, 22)

  $lblNote = New-Object System.Windows.Forms.Label
  $lblNote.SetBounds(12, 206, 480, 40)
  $lblNote.ForeColor = [System.Drawing.Color]::Gray
  $lblNote.Text = "Changes apply within a minute. No restart, no sign-in needed. " +
  "The service seeds this file from supervisor/config.json on its first start."

  $btnSave = New-Object System.Windows.Forms.Button
  $btnSave.SetBounds(12, 254, 90, 28)
  $btnSave.Text = "Save"

  $script:lblSaved = New-Object System.Windows.Forms.Label
  $script:lblSaved.SetBounds(112, 258, 380, 22)

  $script:numEvery.Enabled = $script:radioAuto.Checked
  $script:radioAuto.add_CheckedChanged({ $script:numEvery.Enabled = $script:radioAuto.Checked })


  $btnSave.add_Click({
      $branch = $script:txtBranch.Text.Trim()
      if (-not $branch) {
        [System.Windows.Forms.MessageBox]::Show("Branch to follow can't be empty.", "Ledgr",
          [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
        return
      }
      $minutes = [int]$script:numEvery.Value
      if ($minutes -lt 1 -or $minutes -gt 1440) {
        [System.Windows.Forms.MessageBox]::Show("Minutes must be between 1 and 1440.", "Ledgr",
          [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
        return
      }
      if (-not $script:policyPath) {
        [System.Windows.Forms.MessageBox]::Show("No data folder is configured; can't save.", "Ledgr",
          [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
        return
      }
      $policy = [ordered]@{
        mode          = if ($script:radioManual.Checked) { "manual" } else { "auto" }
        everyMinutes  = $minutes
        branch        = $branch
        repo          = $script:txtRepo.Text.Trim()
        updatedAt     = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
      }
      $json = $policy | ConvertTo-Json -Depth 3
      $utf8NoBom = New-Object System.Text.UTF8Encoding $false
      [System.IO.File]::WriteAllText($script:policyPath, $json, $utf8NoBom)
      $script:lblSaved.Text = "Saved. Takes effect within a minute."
    })

  $tabSettings.Controls.AddRange(@(
      $script:radioAuto, $lblEvery1, $script:numEvery, $lblEvery2, $script:radioManual,
      $lblBranch, $script:txtBranch, $lblRepo, $script:txtRepo, $lblNote, $btnSave, $script:lblSaved
    ))

  $tabs.TabPages[0] = $tabStatus
  $tabs.TabPages[1] = $tabSettings
  $script:form.Controls.Add($tabs)

  # -- Refresh (status tab only; settings load once on open) -------------------

  # Disk-size measuring runs after the form is shown, via a one-shot timer, so
  # opening the window never blocks on walking builds\ (which can hold several
  # node_modules trees).
  $script:diskTimer = New-Object System.Windows.Forms.Timer
  $script:diskTimer.Interval = 200
  $script:diskTimer.add_Tick({
      $script:diskTimer.Stop()
      if ($DataDir) {
        $dbBytes = Get-DirBytes (Join-Path $DataDir "pg")
        $buildsBytes = Get-DirBytes (Join-Path $DataDir "builds")
        $snapBytes = Get-DirBytes (Join-Path $DataDir "snapshots")
        $total = $dbBytes + $buildsBytes + $snapBytes
        $script:lblDisk.Text =
        "Database: $(Format-Bytes $dbBytes)`r`n" +
        "Builds: $(Format-Bytes $buildsBytes)`r`n" +
        "Snapshots: $(Format-Bytes $snapBytes)`r`n" +
        "Total: $(Format-Bytes $total)"
      } else {
        $script:lblDisk.Text = "No data folder configured."
      }
    })

  $script:pollTimer = New-Object System.Windows.Forms.Timer
  $script:pollTimer.Interval = [Math]::Max(3, $PollSeconds) * 1000
  $script:pollTimer.add_Tick({ Refresh-Status })

  $script:form.add_Shown({
      Load-Policy
      Refresh-Status
      $script:diskTimer.Start()
      $script:pollTimer.Start()
    })
  $script:form.add_FormClosed({
      $script:diskTimer.Stop(); $script:diskTimer.Dispose()
      $script:pollTimer.Stop(); $script:pollTimer.Dispose()
      $script:statusForm = $null
    })

  return $script:form
}

function Show-StatusWindow {
  if ($script:statusForm -and -not $script:statusForm.IsDisposed) {
    if ($script:statusForm.WindowState -eq [System.Windows.Forms.FormWindowState]::Minimized) {
      $script:statusForm.WindowState = [System.Windows.Forms.FormWindowState]::Normal
    }
    $script:statusForm.Activate()
    return
  }
  $script:statusForm = New-StatusForm
  $script:statusForm.Show()
  $script:statusForm.Activate()
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miOpen = $menu.Items.Add("Open Ledgr")
$miOpen.add_Click({ Start-Process "http://localhost:$AppPort" })

$miStatus = $menu.Items.Add("Ledgr status...")
$miStatus.add_Click({ Show-StatusWindow })

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$miStart = $menu.Items.Add("Start")
$miStart.add_Click({
    Show-Balloon "Ledgr" "Starting the local service. This takes up to a minute."
    Invoke-Ctl "boot"
  })

$miRestart = $menu.Items.Add("Restart")
$miRestart.add_Click({
    Show-Balloon "Ledgr" "Restarting the local service. This takes up to a minute."
    Invoke-Ctl "restart"
  })

$miStop = $menu.Items.Add("Stop")
$miStop.add_Click({
    $answer = [System.Windows.Forms.MessageBox]::Show(
      "Stop the local Ledgr service? Ledgr will be unreachable on this machine until it is started again.",
      "Ledgr", [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Warning)
    if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) {
      Show-Balloon "Ledgr" "Stopping the local service."
      Invoke-Ctl "stop"
    }
  })

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

# Deliberately worded as hiding the ICON, not quitting Ledgr, because those are
# different things and the menu is the only place that distinction is visible.
$miExit = $menu.Items.Add("Hide this icon (Ledgr keeps running)")
$miExit.add_Click({
    $notify.Visible = $false
    [System.Windows.Forms.Application]::Exit()
  })

$notify.ContextMenuStrip = $menu
$notify.add_MouseDoubleClick({ Start-Process "http://localhost:$AppPort" })

# ── Poll ─────────────────────────────────────────────────────────────────────

$script:lastState = ""

function Update-Icon {
  $state = Get-PeerState
  if ($state -eq $script:lastState) { return }
  $notify.Icon = $icons[$state]
  $notify.Text = $labels[$state]
  # Only a fall FROM working is worth interrupting anyone over. Coming back up
  # is good news that the colour already carries.
  if ($script:lastState -eq "serving" -and $state -eq "down") {
    Show-Balloon "Ledgr stopped" "Nothing is answering on port $AppPort. Right-click this icon to start it."
  }
  $script:lastState = $state
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(3, $PollSeconds) * 1000
$timer.add_Tick({ Update-Icon })
$timer.Start()
Update-Icon

try {
  [System.Windows.Forms.Application]::Run()
} finally {
  $timer.Stop()
  $notify.Visible = $false
  $notify.Dispose()
  foreach ($i in $icons.Values) { $i.Dispose() }
}
