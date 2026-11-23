# JARVIS one-line installer for Windows.
# Usage (normal PowerShell window, NOT as administrator):
#   irm https://raw.githubusercontent.com/jordy1721/JARVIS/claude/practical-cerf-mwk3di/install-jarvis.ps1 | iex
#
# What it does: makes sure Node.js is installed, downloads the latest JARVIS into
# %USERPROFILE%\JARVIS (keeping a backup of any previous copy), installs it, adds a
# desktop shortcut, and starts JARVIS. Your memory, tasks and settings live in AppData
# and are not touched.

$ErrorActionPreference = 'Stop'
$Branch = 'claude/practical-cerf-mwk3di'
$ZipUrl = "https://github.com/jordy1721/JARVIS/archive/refs/heads/$Branch.zip"
$Target = Join-Path $env:USERPROFILE 'JARVIS'

function Say($msg) { Write-Host "  $msg" -ForegroundColor Cyan }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

Write-Host ''
Write-Host '  J A R V I S   installer' -ForegroundColor White
Write-Host ''

# 1. Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Say 'Node.js not found - installing it with winget...'
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements | Out-Host
    Refresh-Path
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host '  Could not install Node.js automatically. Install the LTS version from https://nodejs.org and run this again.' -ForegroundColor Yellow
    Start-Process 'https://nodejs.org/en/download'
    return
  }
}
Say "Node.js $(node --version) found."

# 2. Stop a running JARVIS so files aren't locked
Get-Process -Name 'electron' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Target*" } | Stop-Process -Force -ErrorAction SilentlyContinue

# 3. Download the latest version
$tmp = Join-Path $env:TEMP ("jarvis-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$zip = Join-Path $tmp 'jarvis.zip'
Say 'Downloading the latest JARVIS...'
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -Uri $ZipUrl -OutFile $zip -UseBasicParsing
Expand-Archive -Path $zip -DestinationPath $tmp -Force
$extracted = Get-ChildItem -Path $tmp -Directory | Select-Object -First 1

# 4. Replace the old copy (kept as a backup)
if (Test-Path $Target) {
  $backup = "$Target-old-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
  Say "Keeping your previous copy at $backup"
  Move-Item -Path $Target -Destination $backup
}
Move-Item -Path $extracted.FullName -Destination $Target
Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue

# 5. Install dependencies (npm.cmd avoids PowerShell's script-execution policy)
Say 'Installing (this takes a few minutes the first time)...'
Push-Location $Target
try {
  & npm.cmd install --no-audit --no-fund | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit code $LASTEXITCODE). Scroll up for the error." }
} finally {
  Pop-Location
}

# 6. Desktop shortcut
try {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut((Join-Path $desktop 'JARVIS.lnk'))
  $lnk.TargetPath = Join-Path $Target 'start-jarvis.bat'
  $lnk.WorkingDirectory = $Target
  $lnk.IconLocation = (Join-Path $Target 'node_modules\electron\dist\electron.exe') + ',0'
  $lnk.Save()
  Say 'Added a JARVIS shortcut to your desktop.'
} catch {
  Say 'Could not create a desktop shortcut (you can start JARVIS with start-jarvis.bat).'
}

# 7. Start
Say "Installed to $Target. Starting JARVIS..."
Start-Process -FilePath (Join-Path $Target 'start-jarvis.bat') -WorkingDirectory $Target
Write-Host ''
Write-Host '  Done. Next time, just double-click the JARVIS shortcut on your desktop.' -ForegroundColor Green
Write-Host ''
