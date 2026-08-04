[CmdletBinding()]
param(
  [string]$RunnerRoot = 'C:\dev\cloud-gpu-runner',
  [ValidateRange(12, 36)][int]$TimeoutHours = 24
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $RunnerRoot).Path
$artifacts = Join-Path $root 'artifacts\cloud-gpu\kakaotalk-persona'
$private = Join-Path $root 'etc\kakaotalk-persona'
$deadline = (Get-Date).AddHours($TimeoutHours)

while ((Get-Date) -lt $deadline) {
  & (Join-Path $PSScriptRoot 'Extract-CampaignArtifacts.ps1') -RunnerRoot $root | Out-Null
  $adapters = @(Get-ChildItem -LiteralPath $artifacts -Filter '*-lora-f16.gguf' -File -Recurse -ErrorAction SilentlyContinue)
  $server = Get-ChildItem -LiteralPath (Join-Path $private 'llama.cpp') -Filter 'llama-server.exe' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  $modelsReady = (Test-Path -LiteralPath (Join-Path $private 'models\Qwen3-30B-A3B-Q4_K_M.gguf')) -and (Test-Path -LiteralPath (Join-Path $private 'models\Qwen3-14B-Q4_K_M.gguf'))
  if ($adapters.Count -ge 2 -and $server -and $modelsReady) {
    [pscustomobject]@{Ready=$true;CompletedAt=(Get-Date).ToString('o');Adapters=@($adapters.FullName);LlamaServer=$server.FullName} | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $private 'local-ready.json') -Encoding UTF8
    exit 0
  }
  Start-Sleep -Seconds 60
}

[pscustomobject]@{Ready=$false;TimedOutAt=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $private 'local-ready.json') -Encoding UTF8
exit 1
