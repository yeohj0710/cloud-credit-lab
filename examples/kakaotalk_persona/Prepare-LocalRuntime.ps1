[CmdletBinding()]
param([string]$RunnerRoot = 'C:\dev\cloud-gpu-runner')

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $RunnerRoot).Path
$base = Join-Path $root 'etc\kakaotalk-persona'
$downloads = Join-Path $base 'downloads'
$runtime = Join-Path $base 'llama.cpp'
$models = Join-Path $base 'models'
New-Item -ItemType Directory -Force -Path $downloads, $runtime, $models | Out-Null

function Receive-VerifiedFile([string]$Url, [string]$Destination, [long]$ExpectedBytes, [string]$ExpectedSha256) {
  if ((Test-Path -LiteralPath $Destination) -and (Get-Item -LiteralPath $Destination).Length -eq $ExpectedBytes) {
    $actual = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -eq $ExpectedSha256) { return }
  }
  & curl.exe --fail --location --retry 10 --retry-delay 5 --continue-at - --output $Destination $Url
  if ($LASTEXITCODE -ne 0) { throw "Download failed: $Destination" }
  if ((Get-Item -LiteralPath $Destination).Length -ne $ExpectedBytes) { throw "Downloaded size mismatch: $Destination" }
  $actual = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $ExpectedSha256) { throw "Downloaded hash mismatch: $Destination" }
}

$llamaZip = Join-Path $downloads 'llama-b10199-bin-win-cuda-12.4-x64.zip'
$cudaZip = Join-Path $downloads 'cudart-llama-bin-win-cuda-12.4-x64.zip'
Receive-VerifiedFile 'https://github.com/ggml-org/llama.cpp/releases/download/b10199/llama-b10199-bin-win-cuda-12.4-x64.zip' $llamaZip 250988138 '34b0073cf5c7b2412066b89ad5374ae96663005d50852ce3ae59a1f6dafe793f'
Receive-VerifiedFile 'https://github.com/ggml-org/llama.cpp/releases/download/b10199/cudart-llama-bin-win-cuda-12.4-x64.zip' $cudaZip 391443627 '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6'
Expand-Archive -LiteralPath $llamaZip -DestinationPath $runtime -Force
Expand-Archive -LiteralPath $cudaZip -DestinationPath $runtime -Force

Receive-VerifiedFile 'https://huggingface.co/Qwen/Qwen3-30B-A3B-GGUF/resolve/main/Qwen3-30B-A3B-Q4_K_M.gguf' `
  (Join-Path $models 'Qwen3-30B-A3B-Q4_K_M.gguf') 18556685824 '0d003f6662faee786ed5da3e31b29c978de5ae5d275c8794c606a7f3c01aa8f5'
Receive-VerifiedFile 'https://huggingface.co/Qwen/Qwen3-14B-GGUF/resolve/main/Qwen3-14B-Q4_K_M.gguf' `
  (Join-Path $models 'Qwen3-14B-Q4_K_M.gguf') 9001752960 '500a8806e85ee9c83f3ae08420295592451379b4f8cf2d0f41c15dffeb6b81f0'

$server = Get-ChildItem -LiteralPath $runtime -Filter 'llama-server.exe' -File -Recurse | Select-Object -First 1
if (-not $server) { throw 'llama-server.exe was not found after extraction.' }
[pscustomobject]@{
  Ready = $true
  LlamaServer = $server.FullName
  Model30B = Join-Path $models 'Qwen3-30B-A3B-Q4_K_M.gguf'
  Model14B = Join-Path $models 'Qwen3-14B-Q4_K_M.gguf'
} | ConvertTo-Json
