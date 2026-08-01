[CmdletBinding()]
param(
  [Parameter(Position = 0)][ValidateSet('status', 'run')][string]$Action = 'status',
  [ValidateSet('auto', 'naver', 'kakao')][string]$Provider = 'auto',
  [ValidateRange(1, 1440)][int]$Minutes = 60,
  [ValidateRange(50, 2000)][int]$VolumeGB = 80,
  [string]$NaverSpecCode,
  [ValidateRange(1, 2)][int]$ParallelJobLimit = 1,
  [string]$ProjectPath,
  [string]$DataPath,
  [string]$Command,
  [switch]$ApproveEstimatedCost,
  [ValidateRange(1, 10000000)][decimal]$MaxEstimatedCostKRW = 2000,
  [bool]$Wait = $true,
  [ValidateRange(5, 300)][int]$PollSeconds = 15,
  [string]$DownloadDirectory,
  [switch]$DeleteRemoteArtifacts,
  [string]$BaseUrl = 'https://cloud-gpu-runner.vercel.app',
  [string]$Password
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if ($Action -eq 'status') {
  $args = @{ Minutes = $Minutes; VolumeGB = $VolumeGB; BaseUrl = $BaseUrl }
  if ($Provider -ne 'auto') { $args.Provider = $Provider }
  if ($Password) { $args.Password = $Password }
  & (Join-Path $PSScriptRoot 'Get-CloudCreditStatus.ps1') @args
  exit $LASTEXITCODE
}

if (-not $ProjectPath) { throw '-ProjectPath is required for run.' }
$args = @{
  ProjectPath = $ProjectPath
  Provider = $Provider
  Minutes = $Minutes
  VolumeGB = $VolumeGB
  MaxEstimatedCostKRW = $MaxEstimatedCostKRW
  Wait = $Wait
  PollSeconds = $PollSeconds
  BaseUrl = $BaseUrl
  ParallelJobLimit = $ParallelJobLimit
}
if ($DataPath) { $args.DataPath = $DataPath }
if ($NaverSpecCode) { $args.NaverSpecCode = $NaverSpecCode }
if ($Command) { $args.Command = $Command }
if ($ApproveEstimatedCost) { $args.ApproveEstimatedCost = $true }
if ($DownloadDirectory) { $args.DownloadDirectory = $DownloadDirectory }
if ($DeleteRemoteArtifacts) { $args.DeleteRemoteArtifacts = $true }
if ($Password) { $args.Password = $Password }
& (Join-Path $PSScriptRoot 'Submit-GpuJob.ps1') @args
exit $LASTEXITCODE

