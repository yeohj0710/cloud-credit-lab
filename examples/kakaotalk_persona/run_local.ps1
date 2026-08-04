[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$LlamaServer,
  [Parameter(Mandatory = $true)][string]$BaseModel,
  [Parameter(Mandatory = $true)][string]$Adapter,
  [ValidateRange(512, 8192)][int]$Context = 2048,
  [ValidateRange(1, 65535)][int]$Port = 8080,
  [ValidateRange(0, 200)][int]$GpuLayers = 40
)

$ErrorActionPreference = 'Stop'
$server = (Resolve-Path -LiteralPath $LlamaServer).Path
$model = (Resolve-Path -LiteralPath $BaseModel).Path
$lora = (Resolve-Path -LiteralPath $Adapter).Path

& $server `
  --model $model `
  --lora $lora `
  --ctx-size $Context `
  --n-gpu-layers $GpuLayers `
  --flash-attn on `
  --host 127.0.0.1 `
  --port $Port
