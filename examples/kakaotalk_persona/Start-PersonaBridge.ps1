[CmdletBinding()]
param(
  [string]$RunnerRoot = 'C:\dev\cloud-gpu-runner',
  [switch]$SyncVercel,
  [switch]$DeployPreview
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $RunnerRoot).Path
$private = Join-Path $root 'etc\kakaotalk-persona'
$statePath = Join-Path $private 'persona-online-state.json'
$envPath = Join-Path $root '.env.local'
$bridgeLog = Join-Path $private 'persona-bridge.stdout.log'
$bridgeError = Join-Path $private 'persona-bridge.stderr.log'
$tunnelLog = Join-Path $private 'persona-tunnel.stdout.log'
$tunnelError = Join-Path $private 'persona-tunnel.stderr.log'

function Read-EnvValue([string]$Name) {
  $line = Get-Content -LiteralPath $envPath | Where-Object { $_ -match ('^' + [regex]::Escape($Name) + '=') } | Select-Object -Last 1
  if (-not $line) { return '' }
  return ($line -split '=', 2)[1].Trim().Trim('"').Trim("'")
}

function Stop-RecordedProcess([object]$State, [string]$Property, [string]$Expected) {
  $processId = [int]($State.$Property)
  if ($processId -le 0) { return }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
  if ($process -and $process.CommandLine -match $Expected) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }
}

if (-not (Test-Path -LiteralPath $envPath)) { throw '.env.local was not found.' }
$secret = Read-EnvValue 'PERSONA_BRIDGE_SECRET'
if ($secret.Length -lt 32) { throw 'PERSONA_BRIDGE_SECRET must contain at least 32 characters.' }
$cloudflaredCommand = Get-Command cloudflared -ErrorAction SilentlyContinue
$cloudflared = if ($cloudflaredCommand) { $cloudflaredCommand.Source } else {
  Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages') -Filter 'cloudflared.exe' -File -Recurse -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty FullName -First 1
}
if (-not $cloudflared -or -not (Test-Path -LiteralPath $cloudflared)) { throw 'cloudflared.exe was not found.' }
$node = (Get-Command node -ErrorAction Stop).Source
New-Item -ItemType Directory -Force -Path $private | Out-Null

if (Test-Path -LiteralPath $statePath) {
  $previous = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
  Stop-RecordedProcess $previous 'tunnel_pid' 'cloudflared'
  Stop-RecordedProcess $previous 'bridge_pid' 'local_bridge\.mjs'
}
$staleProcesses = Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'local_bridge\.mjs') -or
  ($_.Name -eq 'cloudflared.exe' -and $_.CommandLine -match '127\.0\.0\.1:8090')
}
foreach ($process in $staleProcesses) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500

$bridge = Start-Process -FilePath $node -ArgumentList @('--env-file=.env.local', 'examples\kakaotalk_persona\local_bridge.mjs') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $bridgeLog -RedirectStandardError $bridgeError -PassThru
$bridgeDeadline = (Get-Date).AddSeconds(20)
$bridgeReady = $false
while ((Get-Date) -lt $bridgeDeadline) {
  if ($bridge.HasExited) { throw 'The local persona bridge exited during startup.' }
  try { $bridgeReady = (Invoke-WebRequest 'http://127.0.0.1:8090/healthz' -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch {}
  if ($bridgeReady) { break }
  Start-Sleep -Milliseconds 500
}
if (-not $bridgeReady) { Stop-Process -Id $bridge.Id -Force -ErrorAction SilentlyContinue; throw 'The local persona bridge did not become ready.' }
$bridgeStatePath = Join-Path $private 'persona-bridge-state.json'
$bridgeState = Get-Content -Raw -LiteralPath $bridgeStatePath | ConvertFrom-Json
$bridgePid = [int]$bridgeState.bridge_pid
$actualBridge = Get-CimInstance Win32_Process -Filter "ProcessId=$bridgePid" -ErrorAction SilentlyContinue
if (-not $actualBridge -or $actualBridge.CommandLine -notmatch 'local_bridge\.mjs') { throw 'The local persona bridge did not report a valid process ID.' }

$tunnel = Start-Process -FilePath $cloudflared -ArgumentList @('tunnel', '--url', 'http://127.0.0.1:8090', '--no-autoupdate', '--loglevel', 'info') -WindowStyle Hidden -RedirectStandardOutput $tunnelLog -RedirectStandardError $tunnelError -PassThru
$tunnelDeadline = (Get-Date).AddSeconds(45)
$tunnelUrl = ''
while ((Get-Date) -lt $tunnelDeadline) {
  if ($tunnel.HasExited) { break }
  $text = ((Get-Content -Raw -LiteralPath $tunnelLog -ErrorAction SilentlyContinue) + "`n" + (Get-Content -Raw -LiteralPath $tunnelError -ErrorAction SilentlyContinue))
  $match = [regex]::Match($text, 'https://[a-z0-9-]+\.trycloudflare\.com')
  if ($match.Success) { $tunnelUrl = $match.Value; break }
  Start-Sleep -Seconds 1
}
if (-not $tunnelUrl) {
  Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
  Stop-Process -Id $bridge.Id -Force -ErrorAction SilentlyContinue
  throw 'Cloudflare Quick Tunnel did not provide an HTTPS URL.'
}

$deploymentUrl = ''
$state = [ordered]@{
  started_at = (Get-Date).ToString('o')
  bridge_pid = $bridgePid
  tunnel_pid = $tunnel.Id
  tunnel_url = $tunnelUrl
  deployment_url = $deploymentUrl
  idle_timeout_minutes = [int](Read-EnvValue 'PERSONA_IDLE_TIMEOUT_MINUTES')
}
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
if ($SyncVercel) {
  $npx = (Get-Command npx.cmd -ErrorAction Stop).Source
  $savedPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $npx --yes vercel@latest env rm PERSONA_BRIDGE_URL preview -y 2>&1 | Out-Null
  $tunnelUrl | & $npx --yes vercel@latest env add PERSONA_BRIDGE_URL preview 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { $ErrorActionPreference = $savedPreference; throw 'Failed to set PERSONA_BRIDGE_URL in Vercel Preview.' }
  & $npx --yes vercel@latest env rm PERSONA_BRIDGE_SECRET preview -y 2>&1 | Out-Null
  $secret | & $npx --yes vercel@latest env add PERSONA_BRIDGE_SECRET preview --sensitive 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { $ErrorActionPreference = $savedPreference; throw 'Failed to set PERSONA_BRIDGE_SECRET in Vercel Preview.' }
  if ($DeployPreview) {
    $deployOutput = & $npx --yes vercel@latest deploy -y --force 2>&1
    if ($LASTEXITCODE -ne 0) { $ErrorActionPreference = $savedPreference; throw 'Vercel Preview deployment failed.' }
    $deploymentUrl = @($deployOutput | ForEach-Object { [regex]::Matches([string]$_, 'https://[^\s]+\.vercel\.app') | ForEach-Object Value }) | Select-Object -Last 1
    if (-not $deploymentUrl) { throw 'Vercel preview deployment URL was not returned.' }
  }
  $ErrorActionPreference = $savedPreference
}

$state.deployment_url = $deploymentUrl
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
[pscustomobject]@{ Ready=$true; TunnelUrl=$tunnelUrl; DeploymentUrl=$deploymentUrl; BridgePid=$bridgePid; TunnelPid=$tunnel.Id } | ConvertTo-Json -Compress
