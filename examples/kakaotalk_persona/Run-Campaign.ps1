[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$DatasetArchive,
  [string]$RunnerRoot = 'C:\dev\cloud-gpu-runner',
  [ValidateRange(420, 600)][int]$Minutes = 540
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$data = (Resolve-Path -LiteralPath $DatasetArchive).Path
$runner = (Resolve-Path -LiteralPath $RunnerRoot).Path
$logDirectory = Join-Path $runner 'etc\kakaotalk-persona\campaign-logs'
$artifactDirectory = Join-Path $runner 'artifacts\cloud-gpu\kakaotalk-persona'
New-Item -ItemType Directory -Force -Path $logDirectory, $artifactDirectory | Out-Null

$stdout = Join-Path $logDirectory 'qwen3-30b-a3b.stdout.log'
$stderr = Join-Path $logDirectory 'qwen3-30b-a3b.stderr.log'
$arguments = @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $project 'Campaign-Worker.ps1'),
  '-Variant', 'qwen3-30b-a3b', '-DatasetArchive', $data, '-RunnerRoot', $runner,
  '-ArtifactDirectory', $artifactDirectory, '-Minutes', "$Minutes"
)
Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr

$firstJobId = $null
$deadline = (Get-Date).AddMinutes(5)
while ((Get-Date) -lt $deadline -and -not $firstJobId) {
  Start-Sleep -Seconds 5
  if (Test-Path -LiteralPath $stdout) {
    $match = [regex]::Match((Get-Content -LiteralPath $stdout -Raw), 'Started naver GPU job: ([0-9a-f-]{36})')
    if ($match.Success) { $firstJobId = $match.Groups[1].Value }
  }
  if ((Test-Path -LiteralPath $stderr) -and (Get-Item -LiteralPath $stderr).Length -gt 0) {
    throw "첫 GPU 작업이 시작되지 않았습니다. 로그: $stderr"
  }
}
if (-not $firstJobId) { throw "첫 GPU Job ID를 5분 안에 확인하지 못했습니다. 로그: $stdout" }

$cleanupArgs = @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $project 'Local-Cleanup-Watcher.ps1'),
  '-JobId', $firstJobId, '-RunnerRoot', $runner, '-DeadlineMinutes', "$($Minutes + 30)"
)
Start-Process -FilePath 'powershell.exe' -ArgumentList $cleanupArgs -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDirectory 'qwen3-30b-a3b.cleanup.stdout.log') `
  -RedirectStandardError (Join-Path $logDirectory 'qwen3-30b-a3b.cleanup.stderr.log')

$sequentialArgs = @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $project 'Sequential-Worker.ps1'),
  '-FirstJobId', $firstJobId, '-DatasetArchive', $data, '-RunnerRoot', $runner, '-Minutes', "$Minutes"
)
Start-Process -FilePath 'powershell.exe' -ArgumentList $sequentialArgs -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDirectory 'sequential.stdout.log') `
  -RedirectStandardError (Join-Path $logDirectory 'sequential.stderr.log')

Write-Output "30B 작업을 시작했고 14B 작업을 순차 대기열에 등록했습니다. 첫 Job ID: $firstJobId"
