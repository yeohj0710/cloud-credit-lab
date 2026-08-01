[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$JobId,
  [string]$RunnerRoot = 'C:\dev\cloud-gpu-runner',
  [ValidateRange(1, 660)][int]$DeadlineMinutes = 630
)

$ErrorActionPreference = 'Stop'
$runner = (Resolve-Path -LiteralPath $RunnerRoot).Path
$envFile = Join-Path $runner '.env.local'
$artifacts = Join-Path $runner 'artifacts\cloud-gpu\kakaotalk-persona'
$deadline = (Get-Date).AddMinutes($DeadlineMinutes)

while ($true) {
  $job = (& node "--env-file=$envFile" (Join-Path $PSScriptRoot 'Local-JobStatus.mjs') $JobId | ConvertFrom-Json)
  if ($LASTEXITCODE -ne 0 -or -not $job) { throw "Local job lookup failed: $JobId" }
  $terminal = @('completed', 'failed', 'cancelled') -contains $job.status
  $clean = (-not $job.instance_id -or $job.instance_deleted_at) -and (-not $job.cleanup_error)
  if ($terminal -and $clean) { exit 0 }
  if ($terminal -or (Get-Date) -ge $deadline) {
    Start-Sleep -Seconds 10
    & node "--env-file=$envFile" (Join-Path $PSScriptRoot 'Local-NcpCleanup.mjs') $JobId $artifacts
    if ($LASTEXITCODE -ne 0) { throw "Local NCP cleanup failed for $JobId" }
    exit 0
  }
  Start-Sleep -Seconds 30
}
