[CmdletBinding()]
param([string]$RunnerRoot = 'C:\dev\cloud-gpu-runner')

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $RunnerRoot).Path
$artifacts = Join-Path $root 'artifacts\cloud-gpu\kakaotalk-persona'
$results = Get-ChildItem -LiteralPath $artifacts -Filter 'result.tar.gz' -File -Recurse -ErrorAction SilentlyContinue
foreach ($result in $results) {
  $destination = Join-Path $result.DirectoryName 'extracted'
  New-Item -ItemType Directory -Force -Path $destination | Out-Null
  & tar.exe -xzf $result.FullName -C $destination
  if ($LASTEXITCODE -ne 0) { throw "Artifact extraction failed: $($result.FullName)" }
}

$adapters = Get-ChildItem -LiteralPath $artifacts -Filter '*-lora-f16.gguf' -File -Recurse -ErrorAction SilentlyContinue
[pscustomobject]@{
  ExtractedResults = $results.Count
  LoraAdapters = @($adapters.FullName)
} | ConvertTo-Json -Depth 3
