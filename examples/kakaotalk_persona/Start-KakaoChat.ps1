[CmdletBinding()]
param(
  [ValidateSet('30b', '14b')][string]$Variant = '30b',
  [ValidateRange(512, 8192)][int]$Context = 2048,
  [ValidateRange(0, 200)][int]$GpuLayers = 40,
  [ValidateRange(1, 65535)][int]$Port = 8080,
  [string]$RunnerRoot = 'C:\dev\cloud-gpu-runner'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $RunnerRoot).Path
$private = Join-Path $root 'etc\kakaotalk-persona'
$artifacts = Join-Path $root 'artifacts\cloud-gpu\kakaotalk-persona'
$server = Get-ChildItem -LiteralPath (Join-Path $private 'llama.cpp') -Filter 'llama-server.exe' -File -Recurse | Select-Object -First 1
if (-not $server) { throw '로컬 llama-server 준비가 아직 끝나지 않았습니다.' }

if ($Variant -eq '30b') {
  $model = Join-Path $private 'models\Qwen3-30B-A3B-Q4_K_M.gguf'
  $adapter = Get-ChildItem -LiteralPath $artifacts -Filter 'qwen3-30b-a3b-kakao-lora-f16.gguf' -File -Recurse | Select-Object -First 1
} else {
  $model = Join-Path $private 'models\Qwen3-14B-Q4_K_M.gguf'
  $adapter = Get-ChildItem -LiteralPath $artifacts -Filter 'qwen3-14b-kakao-lora-f16.gguf' -File -Recurse | Select-Object -First 1
}
if (-not (Test-Path -LiteralPath $model)) { throw "로컬 기본 모델이 아직 없습니다: $model" }
if (-not $adapter) { throw "$Variant LoRA 어댑터가 아직 없습니다." }

& (Join-Path $PSScriptRoot 'run_local.ps1') `
  -LlamaServer $server.FullName -BaseModel $model -Adapter $adapter.FullName `
  -Context $Context -Port $Port -GpuLayers $GpuLayers
