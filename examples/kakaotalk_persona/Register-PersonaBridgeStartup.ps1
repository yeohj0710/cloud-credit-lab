[CmdletBinding()]
param(
  [string]$RunnerRoot = 'C:\dev\cloud-gpu-runner',
  [string]$TaskName = 'Wellnessbox Persona Bridge'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $RunnerRoot).Path
$startScript = Join-Path $root 'examples\kakaotalk_persona\Start-PersonaBridge.ps1'
if (-not (Test-Path -LiteralPath $startScript)) { throw 'Start-PersonaBridge.ps1 was not found.' }

$arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`" -RunnerRoot `"$root`" -SyncVercel -DeployPreview"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = 'PT1M'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([timespan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Restores the private persona bridge, tunnel, and Vercel Preview after Windows login.' -Force | Out-Null
[pscustomobject]@{ Registered = $true; TaskName = $TaskName; DelaySeconds = 60 } | ConvertTo-Json -Compress
