# Conduit bridge uninstaller for Windows (PowerShell 5+).
#
# Removes what install.ps1 set up: the scheduled tasks ConduitBridge and
# ConduitTunnel (and the processes they started), the bridge program, the
# tunnel script and the tunnel token. Chat history, keys, configuration, logs,
# attachments and speech models are kept unless -Purge is given. Before
# anything is removed the script lists every path and asks.
#
# Usage:  powershell -ExecutionPolicy Bypass -File "$HOME\.conduit\bridge\src\uninstall.ps1" [-Purge] [-Yes] [-DryRun]
#   -Purge   also delete the local data listed under "Data"
#   -Yes     do not ask for confirmation (for scripted removal)
#   -DryRun  only show what would be removed
#
# CONDUIT_DIR selects another install directory, as for install.ps1.
param([switch]$Purge, [switch]$Yes, [switch]$DryRun)
$ErrorActionPreference = "Stop"

$Dir = if ($env:CONDUIT_DIR) { $env:CONDUIT_DIR } else { Join-Path $HOME ".conduit" }
$BridgeDir = Join-Path $Dir "bridge"
$EnvFile = Join-Path $BridgeDir ".env.local"

# A setting as the bridge saw it: .env.local (KEY=value, taken literally, like
# start.ps1), else the bridge's own default. Paths are joined one part at a
# time so the script also runs under pwsh on other systems (used by the tests).
$settings = @{}
if (Test-Path -LiteralPath $EnvFile) {
  foreach ($line in Get-Content -LiteralPath $EnvFile -Encoding UTF8) {
    if ($line -match '^([A-Za-z0-9_]+)=(.*)$') { $settings[$Matches[1]] = $Matches[2] }
  }
}
function Setting($key, $default) { if ($settings[$key]) { $settings[$key] } else { $default } }
$DbDir      = Setting "DB_DIR" (Join-Path (Join-Path $HOME "Library") "conduit-bridge")
$LogDir     = Setting "LOG_DIR" (Join-Path (Join-Path (Join-Path $HOME "Library") "Logs") "conduit-bridge")
$PasteDir   = Setting "PASTE_DIR" (Join-Path (Join-Path (Join-Path $HOME "Library") "conduit-bridge") "pastes")
$ModelsDir  = Setting "CONDUIT_MODELS_DIR" (Join-Path (Join-Path $HOME ".conduit") "models")
$RuntimeDir = Setting "CONDUIT_SPEECH_RUNTIME_DIR" (Join-Path (Join-Path $HOME ".conduit") "speech-runtime")
$Identity   = Setting "CONDUIT_IDENTITY_PATH" (Join-Path $DbDir "identity.key")

# Never anything that is not clearly ours: only absolute paths below the
# drive root, and never the home directory itself.
# GetFullPath makes the path canonical (repeated separators, "." and ".."),
# and only that canonical form is used afterwards. Refused as well: anything
# that contains the home directory.
function Get-SafePath($p) {
  if (-not $p) { return $null }
  if (-not [IO.Path]::IsPathRooted($p)) { return $null }
  $full = [IO.Path]::GetFullPath($p).TrimEnd('\', '/')
  $homeFull = [IO.Path]::GetFullPath($HOME).TrimEnd('\', '/')
  $cmp = [StringComparison]::OrdinalIgnoreCase
  if (-not $full) { return $null }
  if ($full.Equals($homeFull, $cmp)) { return $null }
  if ($full.Equals([IO.Path]::GetPathRoot($full).TrimEnd('\', '/'), $cmp)) { return $null }
  foreach ($sep in @('\', '/')) { if ($homeFull.StartsWith($full + $sep, $cmp)) { return $null } }
  return $full
}
function Test-Safe($p) { return [bool](Get-SafePath $p) }

$Program = New-Object System.Collections.Generic.List[string]
$Data = New-Object System.Collections.Generic.List[string]
function Add-Path($list, $p) {
  if (-not (Test-Path -LiteralPath $p)) { return }
  $safe = Get-SafePath $p
  if (-not $safe) { Write-Warning "Skipping unsafe path: $p"; return }
  if (-not $list.Contains($safe)) { $list.Add($safe) }
}

$TaskNames = @("ConduitBridge", "ConduitTunnel")
$Tasks = @()
if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
  $Tasks = @($TaskNames | Where-Object { Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue })
}

foreach ($f in @("src", "node_modules", "package.json", "package-lock.json", ".installed-files.json", ".selfupdate",
                 "start.ps1", "LICENSE", "THIRD-PARTY-NOTICES.md", "README.md", "licenses")) {
  Add-Path $Program (Join-Path $BridgeDir $f)
}
Add-Path $Program (Join-Path $Dir "tunnel.ps1")
Add-Path $Program (Join-Path $Dir ".cloudflared-token")
Add-Path $Program (Join-Path $Dir "bin")

foreach ($d in @($DbDir, $BridgeDir)) {
  foreach ($f in @("db.sqlite", "db.sqlite-wal", "db.sqlite-shm", "identity.key")) { Add-Path $Data (Join-Path $d $f) }
}
Add-Path $Data $Identity
Add-Path $Data $EnvFile
Add-Path $Data $PasteDir
if (Test-Path -LiteralPath $LogDir) {
  foreach ($f in Get-ChildItem -LiteralPath $LogDir -Force -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -eq "bridge.log" -or $_.Name -like "bridge.log.*" -or $_.Name -like ".alexa-session*" }) {
    Add-Path $Data $f.FullName
  }
}
Add-Path $Data (Join-Path $Dir "logs")
Add-Path $Data $ModelsDir
Add-Path $Data $RuntimeDir

Write-Host "Conduit bridge uninstall (Windows)`n"
if ($Tasks.Count) { Write-Host "  Scheduled tasks to stop and remove:"; $Tasks | ForEach-Object { Write-Host "    $_" } }
else { Write-Host "  Scheduled tasks: none found" }
if ($Program.Count) { Write-Host "  Program files to remove:"; $Program | ForEach-Object { Write-Host "    $_" } }
else { Write-Host "  Program files: none found" }
if ($Data.Count) {
  if ($Purge) { Write-Host "  Data to DELETE (chat history, keys, configuration, logs, attachments, speech models):" }
  else { Write-Host "  Data kept (run with -Purge to delete it):" }
  $Data | ForEach-Object { Write-Host "    $_" }
} else { Write-Host "  Data: none found" }
Write-Host "  Not touched: the AI command line tools (claude, codex, agy) and their own"
Write-Host "  conversation histories, Node.js, a cloudflared installed by winget, and"
Write-Host "  this bridge's tunnel registration in the Conduit cloud.`n"

if ($DryRun) { Write-Host "Dry run: nothing was changed."; exit 0 }
if (-not $Tasks.Count -and -not $Program.Count -and (-not $Purge -or -not $Data.Count)) { Write-Host "Nothing to remove."; exit 0 }
if (-not $Yes) {
  $answer = Read-Host "Proceed? [y/N]"
  if ($answer -notmatch '^(y|yes)$') { Write-Host "Aborted, nothing was changed."; exit 1 }
}

# The tasks run powershell with start.ps1 / tunnel.ps1, which start node and
# cloudflared. Stopping the task alone can leave those children running, so
# they are ended by their parent's command line.
foreach ($t in $Tasks) {
  Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
}
$scripts = @((Join-Path $BridgeDir "start.ps1"), (Join-Path $Dir "tunnel.ps1"))
$all = @()
if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) { $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) }
$parents = @($all | Where-Object { $cmd = $_.CommandLine; $cmd -and ($scripts | Where-Object { $cmd -like "*$_*" }) })
foreach ($p in $parents) {
  foreach ($c in $all | Where-Object { $_.ParentProcessId -eq $p.ProcessId }) { Stop-Process -Id $c.ProcessId -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
foreach ($t in $Tasks) {
  Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed task $t"
}

# Deletes a tree without ever following a link: a junction or symbolic link
# (a reparse point) is removed as the link itself, its target stays. Remove-Item
# -Recurse cannot be trusted with that on Windows PowerShell 5.1, which follows
# directory links into their targets.
function Test-Reparse($item) { return (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) }
function Remove-Link($item) {
  # Windows removes directory links with RemoveDirectory, Unix with unlink.
  try { [IO.Directory]::Delete($item.FullName, $false) } catch { [IO.File]::Delete($item.FullName) }
}
function Remove-Tree($p) {
  $item = Get-Item -LiteralPath $p -Force -ErrorAction Stop
  if (Test-Reparse $item) { Remove-Link $item; return }
  if ($item.PSIsContainer) {
    foreach ($c in @(Get-ChildItem -LiteralPath $item.FullName -Force -ErrorAction Stop)) { Remove-Tree $c.FullName }
    [IO.Directory]::Delete($item.FullName, $false)
  } else {
    $item.Attributes = [IO.FileAttributes]::Normal
    [IO.File]::Delete($item.FullName)
  }
}

# A process that just ended can hold its files for a moment.
function Remove-Retry($p) {
  for ($i = 0; $i -lt 10; $i++) {
    try { Remove-Tree $p; return } catch {
      if (-not (Test-Path -LiteralPath $p)) { return }
      Start-Sleep -Milliseconds 500
    }
  }
  Write-Warning "Could not remove $p"
}
foreach ($p in $Program) { Remove-Retry $p }
if ($Program.Count) { Write-Host "Removed the program files" }
if ($Purge) {
  foreach ($p in $Data) { Remove-Retry $p }
  if ($Data.Count) { Write-Host "Deleted the local data" }
  foreach ($d in @($LogDir, $DbDir, (Split-Path -Parent $PasteDir), $BridgeDir, $Dir)) {
    if ((Test-Safe $d) -and (Test-Path -LiteralPath $d) -and -not (Get-ChildItem -LiteralPath $d -Force -ErrorAction SilentlyContinue)) {
      Remove-Item -LiteralPath $d -Force -ErrorAction SilentlyContinue
    }
  }
}
Write-Host "Done."
