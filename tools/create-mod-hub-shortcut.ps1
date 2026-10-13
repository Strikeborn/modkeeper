# Creates Desktop\games\ModKeeper.lnk — launches ModKeeper via tools/start-mod-hub.ps1
$ErrorActionPreference = 'Stop'

$modHubDir = Split-Path $PSScriptRoot -Parent
$launcher = Join-Path $PSScriptRoot 'start-mod-hub.ps1'
$gamesDir = Join-Path ([Environment]::GetFolderPath('Desktop')) 'games'
$shortcutPath = Join-Path $gamesDir 'ModKeeper.lnk'

if (-not (Test-Path $launcher)) { throw "Missing launcher: $launcher" }
if (-not (Test-Path $gamesDir)) { New-Item -ItemType Directory -Path $gamesDir -Force | Out-Null }

$args = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`""

$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcutPath)
$link.TargetPath = 'powershell.exe'
$link.Arguments = $args
$link.WorkingDirectory = $modHubDir
$link.Description = 'ModKeeper — scan and manage Steam Workshop, Nexus, and local mods'
$icon = Join-Path $modHubDir 'build\icon.ico'
$electronExe = Join-Path $modHubDir 'node_modules\electron\dist\electron.exe'
if (Test-Path $icon) { $link.IconLocation = "$icon,0" }
elseif (Test-Path $electronExe) { $link.IconLocation = "$electronExe,0" }
$link.Save()

Write-Host "Created: $shortcutPath"
