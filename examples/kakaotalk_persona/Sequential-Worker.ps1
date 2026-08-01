[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$FirstJobId,
  [Parameter(Mandatory = $true)][string]$DatasetArchive,
  [string]$RunnerRoot = 'C:\dev\cloud-gpu-runner',
  [ValidateRange(420, 600)][int]$Minutes = 540,
  [long]$CutoffEpoch = 0
)

$ErrorActionPreference = 'Stop'
$runner = (Resolve-Path -LiteralPath $RunnerRoot).Path
$envFile = Join-Path $runner '.env.local'
while ($true) {
  $job = (& node "--env-file=$envFile" (Join-Path $PSScriptRoot 'Local-JobStatus.mjs') $FirstJobId | ConvertFrom-Json)
  if ($LASTEXITCODE -ne 0 -or -not $job) { throw "First job lookup failed: $FirstJobId" }
  $terminal = @('completed', 'failed', 'cancelled') -contains $job.status
  $clean = (-not $job.instance_id -or $job.instance_deleted_at) -and (-not $job.cleanup_error)
  if ($terminal -and $clean) { break }
  Start-Sleep -Seconds 60
}

Start-Sleep -Seconds 30
if ($CutoffEpoch -gt 0 -and [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() -ge ($CutoffEpoch - 120)) { exit 0 }
$artifacts = Join-Path $runner 'artifacts\cloud-gpu\kakaotalk-persona'
$logDirectory = Join-Path $runner 'etc\kakaotalk-persona\campaign-logs'
$stdout = Join-Path $logDirectory 'qwen3-14b.stdout.log'
$stderr = Join-Path $logDirectory 'qwen3-14b.stderr.log'
$arguments = @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'Campaign-Worker.ps1'),
  '-Variant', 'qwen3-14b', '-DatasetArchive', $DatasetArchive, '-RunnerRoot', $runner,
  '-ArtifactDirectory', $artifacts, '-Minutes', "$Minutes"
)
$worker = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $stdout -RedirectStandardError $stderr

$secondJobId = $null
$startDeadline = (Get-Date).AddMinutes(5)
while ((Get-Date) -lt $startDeadline -and -not $secondJobId -and -not $worker.HasExited) {
  Start-Sleep -Seconds 5
  if (Test-Path -LiteralPath $stdout) {
    $match = [regex]::Match((Get-Content -LiteralPath $stdout -Raw), 'Started naver GPU job: ([0-9a-f-]{36})')
    if ($match.Success) { $secondJobId = $match.Groups[1].Value }
  }
}
if (-not $secondJobId) { throw "두 번째 GPU Job ID를 확인하지 못했습니다. 로그: $stderr" }

$cleanupMinutes = $Minutes + 30
if ($CutoffEpoch -gt 0) {
  $remainingMinutes = [math]::Max(1, [math]::Floor(($CutoffEpoch - [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) / 60))
  $cleanupMinutes = [math]::Min($cleanupMinutes, $remainingMinutes)
}
$cleanupArgs = @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'Local-Cleanup-Watcher.ps1'),
  '-JobId', $secondJobId, '-RunnerRoot', $runner, '-DeadlineMinutes', "$cleanupMinutes"
)
Start-Process -FilePath 'powershell.exe' -ArgumentList $cleanupArgs -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDirectory 'qwen3-14b.cleanup.stdout.log') `
  -RedirectStandardError (Join-Path $logDirectory 'qwen3-14b.cleanup.stderr.log')
while ($true) {
  $job = (& node "--env-file=$envFile" (Join-Path $PSScriptRoot 'Local-JobStatus.mjs') $secondJobId | ConvertFrom-Json)
  if ($LASTEXITCODE -ne 0 -or -not $job) { throw "Second job lookup failed: $secondJobId" }
  $terminal = @('completed', 'failed', 'cancelled') -contains $job.status
  $clean = (-not $job.instance_id -or $job.instance_deleted_at) -and (-not $job.cleanup_error)
  if ($terminal -and $clean) { break }
  Start-Sleep -Seconds 60
}
if ($job.status -ne 'completed') { throw "14B job ended with status $($job.status)." }

& (Join-Path $PSScriptRoot 'Extract-CampaignArtifacts.ps1') -RunnerRoot $runner
