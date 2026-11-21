# Sets up the daily LinkedIn agent on this Windows computer.
#
#   powershell -ExecutionPolicy Bypass -File agents\setup.ps1              set up (or change settings)
#   powershell -ExecutionPolicy Bypass -File agents\setup.ps1 -Uninstall   remove the daily task
#
# Saves your settings in %USERPROFILE%\.personal-crm (never in this repo). The GitHub token and
# LinkedIn password are encrypted with Windows DPAPI: only your Windows account on this computer
# can decrypt them.
param([switch]$Uninstall, [string]$Time = '09:00')

$ErrorActionPreference = 'Stop'
$TaskName = 'Personal CRM - LinkedIn'
$Repo = Split-Path -Parent $PSScriptRoot
$HomeDir = Join-Path $env:USERPROFILE '.personal-crm'

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed the '$TaskName' task. Your settings and browser profile are still in $HomeDir (delete that folder to remove them)."
  exit 0
}

New-Item -ItemType Directory -Force $HomeDir | Out-Null
$ConfigFile = Join-Path $HomeDir 'config.json'
$SecretsFile = Join-Path $HomeDir 'secrets.json'
$config = if (Test-Path $ConfigFile) { Get-Content $ConfigFile -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
$secrets = if (Test-Path $SecretsFile) { Get-Content $SecretsFile -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }

function Set-Field($obj, $name, $value) { $obj | Add-Member -NotePropertyName $name -NotePropertyValue $value -Force }
function Read-Secret($prompt) {
  $s = Read-Host -AsSecureString $prompt
  if ($s.Length -eq 0) { return $null }
  return ConvertFrom-SecureString $s
}

Write-Host ''
Write-Host 'Personal CRM: daily LinkedIn agent setup' -ForegroundColor Cyan
Write-Host 'Press Enter to keep a saved value.'
Write-Host ''

$current = if ($config.dataRepo) { " [$($config.dataRepo)]" } else { '' }
$repoIn = Read-Host "Private data repo, as owner/name$current"
if ($repoIn) { Set-Field $config 'dataRepo' $repoIn.Trim() }
if (-not $config.dataRepo) { throw 'A data repo is needed: the same one the app syncs to (Import & settings).' }

Write-Host 'GitHub token: a fine-grained token with Contents: Read and write on that repo only (you can reuse the app''s).'
$tok = Read-Secret 'GitHub token (hidden)'
if ($tok) { Set-Field $secrets 'githubToken' $tok }
if (-not $secrets.githubToken) { throw 'A GitHub token is needed.' }

Write-Host 'LinkedIn asks for your password each time an archive is requested. Leave it blank to only download archives you request yourself.'
$pw = Read-Secret 'LinkedIn password (hidden)'
if ($pw) { Set-Field $secrets 'linkedinPassword' $pw }

if (-not $config.browserChannel) { Set-Field $config 'browserChannel' 'msedge' }
if (-not $config.requestEveryDays) { Set-Field $config 'requestEveryDays' 1 }
$config | ConvertTo-Json | Set-Content -Encoding utf8 $ConfigFile
$secrets | ConvertTo-Json | Set-Content -Encoding utf8 $SecretsFile
Write-Host "Saved settings in $HomeDir" -ForegroundColor Green

Push-Location $Repo
try {
  if (-not (Test-Path (Join-Path $Repo 'node_modules\playwright-core'))) { npm install }
  Write-Host ''
  Write-Host 'A browser window opens next. Sign in to LinkedIn there (once). It closes by itself.'
  npm run --silent linkedin -- --login
} finally { Pop-Location }

$node = (Get-Command node).Source
$arguments = "--import `"$Repo\test\setup.mjs`" --no-warnings `"$Repo\agents\linkedin\run.ts`""
$action = New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory $Repo
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
# StartWhenAvailable: if the computer was off or asleep at that time, run as soon as it's back.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Downloads your LinkedIn data archive and imports it into Personal CRM.' -Force | Out-Null

Write-Host ''
Write-Host "Done. '$TaskName' runs every day at $Time (or as soon as the computer is on)." -ForegroundColor Green
Write-Host 'Run it now:     npm run linkedin -- --headed'
Write-Host 'Check on it:    npm run linkedin -- --status'
