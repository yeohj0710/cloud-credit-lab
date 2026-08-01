[CmdletBinding()]
param([string]$RunnerRoot = 'C:\dev\cloud-gpu-runner')

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $RunnerRoot).Path
$statePath = Join-Path $root 'etc\kakaotalk-persona\persona-online-state.json'
if (-not (Test-Path -LiteralPath $statePath)) { return [pscustomobject]@{ Stopped=$true; Processes=0 } }
$state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
$stopped = 0
if (Test-Path -LiteralPath (Join-Path $root 'etc\kakaotalk-persona\persona-bridge-state.json')) {
  $bridgeState = Get-Content -Raw -LiteralPath (Join-Path $root 'etc\kakaotalk-persona\persona-bridge-state.json') | ConvertFrom-Json
  $modelPid = [int]$bridgeState.model_pid
  if ($modelPid -gt 0) {
    $modelProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$modelPid" -ErrorAction SilentlyContinue
    if ($modelProcess -and $modelProcess.Name -eq 'llama-server.exe') { & taskkill.exe /PID $modelPid /T /F | Out-Null; $stopped += 1 }
  }
}
foreach ($item in @(@{ Id=$state.tunnel_pid; Pattern='cloudflared' }, @{ Id=$state.bridge_pid; Pattern='local_bridge\.mjs' })) {
  $processId = [int]$item.Id
  if ($processId -le 0) { continue }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
  if ($process -and $process.CommandLine -match $item.Pattern) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue; $stopped += 1 }
}
[pscustomobject]@{ Stopped=$true; Processes=$stopped }
