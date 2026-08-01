[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('qwen3-30b-a3b', 'qwen3-14b')][string]$Variant,
  [Parameter(Mandatory = $true)][string]$DatasetArchive,
  [Parameter(Mandatory = $true)][string]$RunnerRoot,
  [Parameter(Mandatory = $true)][string]$ArtifactDirectory,
  [ValidateRange(420, 600)][int]$Minutes = 540
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$data = (Resolve-Path -LiteralPath $DatasetArchive).Path
$runner = (Resolve-Path -LiteralPath $RunnerRoot).Path
$dataDirectory = Split-Path -Parent $data
$datasetMembers = @(& tar -tzf $data | Sort-Object)
if ($LASTEXITCODE -ne 0 -or ($datasetMembers -join '|') -ne 'eval.jsonl|stats.json|train.jsonl') {
  throw 'Dataset archive contents are invalid.'
}
& python (Join-Path $project 'validate_dataset.py') (Join-Path $dataDirectory 'train.jsonl') (Join-Path $dataDirectory 'eval.jsonl')
if ($LASTEXITCODE -ne 0) { throw 'Dataset JSONL validation failed.' }

if ($Variant -eq 'qwen3-30b-a3b') {
  $spec = 'gp4ls64-g3'
  $cost = [math]::Ceiling(16420 * $Minutes / 60)
  $command = 'python3 -m pip install --upgrade pip setuptools wheel packaging ninja && python3 -m pip install -r requirements.txt && MAX_JOBS=8 python3 -m pip install flash-attn==2.8.0.post2 --no-build-isolation && torchrun --standalone --nproc_per_node=4 train.py --data-archive "$CGR_DATA_FILE" --output "$CGR_OUTPUT_DIR" --train-hours 7.5 --max-length 2048 --lora-rank 64 && LORA_BASE_MODEL_ID=Qwen/Qwen3-30B-A3B LORA_OUTPUT_NAME=qwen3-30b-a3b-kakao-lora-f16.gguf bash export_lora_gguf.sh'
} else {
  $spec = 'gp4ls120-g3'
  $cost = [math]::Ceiling(20800 * $Minutes / 60)
  $command = 'python3 -m pip install --upgrade pip setuptools wheel packaging ninja && python3 -m pip install -r requirements.txt && MAX_JOBS=8 python3 -m pip install flash-attn==2.8.0.post2 --no-build-isolation && torchrun --standalone --nproc_per_node=4 train.py --data-archive "$CGR_DATA_FILE" --output "$CGR_OUTPUT_DIR" --train-hours 7.5 --max-length 4096 --lora-rank 96 --train-model unsloth/Qwen3-14B-bnb-4bit --inference-model Qwen/Qwen3-14B-GGUF && LORA_BASE_MODEL_ID=Qwen/Qwen3-14B LORA_OUTPUT_NAME=qwen3-14b-kakao-lora-f16.gguf bash export_lora_gguf.sh'
}
$trainHours = [math]::Round([math]::Min(7.5, [math]::Max(5.0, ($Minutes / 60) - 1.25)), 2)
$command = $command.Replace('--train-hours 7.5', "--train-hours $trainHours")

& (Join-Path $runner 'scripts\cloud-gpu.ps1') run `
  -Provider naver -Minutes $Minutes -NaverSpecCode $spec -ParallelJobLimit 2 `
  -ProjectPath $project -DataPath $data -Command $command `
  -ApproveEstimatedCost -MaxEstimatedCostKRW $cost -DeleteRemoteArtifacts `
  -DownloadDirectory $ArtifactDirectory
