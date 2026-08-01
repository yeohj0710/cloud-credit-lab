[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ProjectPath,
  [string]$DataPath,
  [string]$Command = 'pip install -r requirements.txt && python train.py --data "$CGR_DATA_FILE" --output "$CGR_OUTPUT_DIR"',
  [ValidateSet('auto', 'naver', 'kakao')][string]$Provider = 'auto',
  [ValidateRange(15, 1440)][int]$Minutes = 60,
  [ValidateRange(50, 2000)][int]$VolumeGB = 80,
  [ValidatePattern('^gp[124]ls?\d+-g3$')][string]$NaverSpecCode,
  [ValidateRange(1, 2)][int]$ParallelJobLimit = 1,
  [switch]$ApproveEstimatedCost,
  [ValidateRange(1, 10000000)][decimal]$MaxEstimatedCostKRW = 2000,
  [bool]$Wait = $true,
  [ValidateRange(5, 300)][int]$PollSeconds = 15,
  [string]$DownloadDirectory,
  [switch]$DeleteRemoteArtifacts,
  [string]$OutputPath = 'outputs',
  [string]$BaseUrl = 'https://cloud-gpu-runner.vercel.app',
  [string]$Password
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
foreach ($agentEnv in @((Join-Path $root '.env.local'), 'C:\dev\cloud-gpu-runner\.env.local')) {
  if (-not $env:CGR_PASSWORD -and (Test-Path -LiteralPath $agentEnv)) {
    Get-Content -LiteralPath $agentEnv | ForEach-Object { if ($_ -match '^CGR_PASSWORD=(.*)$') { $env:CGR_PASSWORD = $matches[1].Trim() } }
  }
}
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
if (-not (Test-Path -LiteralPath $project -PathType Container)) { throw "ProjectPath must be a folder: $project" }
if ($DataPath) { $DataPath = (Resolve-Path -LiteralPath $DataPath).Path }
if (-not $DownloadDirectory) { $DownloadDirectory = Join-Path $project 'artifacts\cloud-gpu' }
if (-not $Password) { $Password = $env:CGR_PASSWORD }
if (-not $Password) { throw 'Set CGR_PASSWORD or pass -Password.' }

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
function Connect-CclSession {
  $loginArgs = @{ Uri = "$BaseUrl/api/login"; Method = 'POST'; WebSession = $session; UseBasicParsing = $true; ContentType = 'application/json'; Body = (@{ password = $Password } | ConvertTo-Json -Compress) }
  return Invoke-RestMethod @loginArgs
}
function Invoke-CclJson([string]$Uri, [string]$Method = 'GET', $Body = $null, [bool]$AllowAuthRetry = $true) {
  $args = @{ Uri = "$BaseUrl$Uri"; Method = $Method; WebSession = $session; UseBasicParsing = $true }
  if ($null -ne $Body) { $args.ContentType = 'application/json'; $args.Body = ($Body | ConvertTo-Json -Depth 12 -Compress) }
  try { return Invoke-RestMethod @args }
  catch {
    $statusCode = [int]$_.Exception.Response.StatusCode
    if ($AllowAuthRetry -and $statusCode -in @(401, 403)) {
      $null = Connect-CclSession
      return Invoke-CclJson $Uri $Method $Body $false
    }
    throw
  }
}
function Get-CclJob([string]$Id) {
  $jobs = Invoke-CclJson '/api/jobs'
  return $jobs.items | Where-Object { $_.id -eq $Id } | Select-Object -First 1
}
function Write-JobEvidence($Job, $Estimate, [string]$Directory, $Usage) {
  New-Item -ItemType Directory -Force -Path $Directory | Out-Null
  $evidence = [ordered]@{
    job_id = $Job.id; provider = $Job.provider; status = $Job.status; stage = $Job.stage
    created_at = $Job.created_at; started_at = $Job.started_at; completed_at = $Job.completed_at
    maximum_runtime_minutes = $Minutes; estimated_cost_krw = [math]::Round([decimal]$Estimate.total, 2)
    actual_cost_krw = if ($null -ne $Job.usage_amount) { [math]::Round([decimal]$Job.usage_amount, 2) } else { $null }
    usage_seconds = $Job.usage_seconds; remaining_credit_krw = $Usage.remaining.$($Job.provider)
    instance_deleted_at = $Job.instance_deleted_at; public_ip_removed_at = $Job.public_ip_removed_at
    instance_cleanup_verified = [bool](-not $Job.instance_id -or $Job.instance_deleted_at)
    public_ip_cleanup_verified = [bool](-not $Job.public_ip_id -or $Job.public_ip_removed_at)
    cleanup_error = $Job.cleanup_error; artifacts_ready = $Job.artifacts_ready; error = $Job.error
  }
  $evidence | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $Directory 'job.json') -Encoding utf8
}

$null = Connect-CclSession
$credit = Invoke-CclJson '/api/usage'
$naver = $null
try { $naver = Invoke-CclJson '/api/ncp-gpu' } catch { if ($Provider -eq 'naver') { throw } }
$resolved = if ($Provider -eq 'auto') { if ($naver -and $naver.ok) { 'naver' } else { 'kakao' } } else { $Provider }
if ($resolved -eq 'naver') {
  if (-not $naver.ok) { throw "NAVER GPU is not ready: $($naver.missing -join ', ')" }
  $eligibleSpecs = $naver.specs | Where-Object { $_.vram_per_gpu_gb -ge 48 }
  $spec = if ($NaverSpecCode) { $eligibleSpecs | Where-Object { $_.serverSpecCode -eq $NaverSpecCode } | Select-Object -First 1 } else { $eligibleSpecs | Sort-Object hourly_rate | Select-Object -First 1 }
  if (-not $spec) { throw 'No NAVER GPU materially exceeds the local RTX 5070 Ti 16GB baseline.' }
  $launch = if ($spec.required_zone_code) { $naver.launch_configs | Where-Object { $_.zone_code -eq $spec.required_zone_code } | Select-Object -First 1 } else { $naver.launch_configs | Select-Object -First 1 }
  if (-not $launch) { throw "No NAVER launch configuration is compatible with $($spec.serverSpecCode)." }
  $estimate = Invoke-CclJson '/api/estimate?type=gpu' 'POST' @{ provider = 'naver'; flavor = $spec.serverSpecCode; minutes = $Minutes; volume_gb = 50 }
  $remaining = $credit.remaining.naver
  $selectedGpu = $spec.serverSpecCode
} else {
  $kakao = Invoke-CclJson '/api/cloud?action=readiness'
  if (-not $kakao.ok) { throw 'Kakao GPU is not ready.' }
  $flavor = $kakao.flavors | Where-Object { $_.manufacturer -eq 'nvidia' -and $_.vram_per_gpu_gb -ge 48 -and $kakao.pricing.gpu_hourly.PSObject.Properties[$_.name].Value } | Sort-Object { $kakao.pricing.gpu_hourly.PSObject.Properties[$_.name].Value } | Select-Object -First 1
  if (-not $flavor) { throw 'No Kakao GPU materially exceeds the local RTX 5070 Ti 16GB baseline.' }
  $image = $kakao.images | Where-Object { $_.name -match 'nvidia' } | Select-Object -First 1
  $estimate = Invoke-CclJson '/api/estimate?type=gpu' 'POST' @{ provider = 'kakao'; flavor = $flavor.name; minutes = $Minutes; volume_gb = $VolumeGB }
  $remaining = $credit.remaining.kakao
  $selectedGpu = $flavor.name
}
Write-Host ("Provider: {0}; GPU: {1}; maximum runtime: {2} minutes" -f $resolved, $selectedGpu, $Minutes)
Write-Host ("Estimated maximum cost: {0:N0} KRW + VAT; estimated credit remaining: {1:N0} KRW" -f $estimate.total, $remaining)
if ([decimal]$estimate.total -gt $MaxEstimatedCostKRW) { throw "Estimated cost $($estimate.total) KRW exceeds hard limit $MaxEstimatedCostKRW KRW." }
if ([decimal]$remaining -lt ([decimal]$estimate.total + 1000)) { throw "Remaining credit cannot cover estimated maximum plus 1,000 KRW safety reserve." }
if (-not $ApproveEstimatedCost) { throw 'Cost approval required. Rerun with -ApproveEstimatedCost only after approval.' }

$etc = Join-Path $root 'etc'
New-Item -ItemType Directory -Force -Path $etc | Out-Null
$archive = Join-Path $etc ("gpu-project-{0}.zip" -f [guid]::NewGuid().ToString('N'))
function Send-CclFile([string]$Path, [string]$Bucket) {
  $name = [IO.Path]::GetFileName($Path) -replace '[^A-Za-z0-9._-]', '-'
  $key = "gpu-workbench/{0}-{1}" -f [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(), $name
  $signed = Invoke-CclJson '/api/ncp-storage?action=upload-url' 'POST' @{ bucket = $Bucket; key = $key }
  Invoke-WebRequest -Uri $signed.url -Method Put -InFile $Path -ContentType 'application/octet-stream' -UseBasicParsing | Out-Null
  $null = Invoke-CclJson '/api/ncp-storage?action=upload-complete' 'POST' @{ bucket = $Bucket; key = $key; size = (Get-Item -LiteralPath $Path).Length }
  return $key
}

$created = $null
try {
  & tar.exe -a -cf $archive --exclude=.git --exclude=.venv --exclude=node_modules --exclude=__pycache__ --exclude=etc --exclude=artifacts --exclude=.env --exclude='.env.*' --exclude=.secrets --exclude='*credentials*' -C $project .
  if ($LASTEXITCODE -ne 0) { throw "Project archive failed: tar exit $LASTEXITCODE" }
  $buckets = Invoke-CclJson '/api/ncp-storage?action=buckets'
  $bucket = ($buckets.items | Where-Object { $_.name -match 'artifact|cloud-gpu|work-memory' } | Select-Object -First 1).name
  if (-not $bucket) { $bucket = ($buckets.items | Select-Object -First 1).name }
  if (-not $bucket) { throw 'No NAVER Object Storage bucket is available.' }
  Write-Host "Uploading project: $project"
  $codeKey = Send-CclFile $archive $bucket
  $dataKey = if ($DataPath) { Write-Host "Uploading data: $DataPath"; Send-CclFile $DataPath $bucket } else { '' }
  $created = Invoke-CclJson '/api/jobs' 'POST' @{ type = 'custom-gpu'; provider = $resolved; bucket = $bucket; code_key = $codeKey; data_key = $dataKey; command = $Command; output_path = $OutputPath }
  if ($resolved -eq 'naver') {
    $loginKeyName = if ($naver.keys[0].loginKeyName) { $naver.keys[0].loginKeyName } else { $naver.keys[0].keyName }
    if (-not $loginKeyName) { throw 'NAVER login key name is missing.' }
    $null = Invoke-CclJson '/api/ncp-gpu' 'POST' @{ job_id = $created.job.id; spec_code = $spec.serverSpecCode; vpc_no = $launch.vpc_no; subnet_no = $launch.subnet_no; login_key_name = $loginKeyName; acg_no = $launch.acg_no; max_minutes = $Minutes; volume_gb = 50; parallel_job_limit = $ParallelJobLimit; execution_password = $Password }
  } else {
    $null = Invoke-CclJson '/api/cloud?action=create' 'POST' @{ job_id = $created.job.id; purpose = 'local-project'; flavor_id = $flavor.id; image_id = $image.id; subnet_id = $kakao.subnets[0].id; key_name = $kakao.keypairs[0].name; security_group = $kakao.security_groups[0].name; max_minutes = $Minutes; volume_gb = $VolumeGB; execution_password = $Password }
  }
  Write-Host "Started $resolved GPU job: $($created.job.id)"
} catch {
  $launchError = $_
  if ($created -and $created.job.id) {
    Write-Warning "GPU launch failed; cancelling job $($created.job.id) to release any partially created resources."
    try { $null = Invoke-CclJson '/api/jobs?action=cancel' 'POST' @{ id = $created.job.id } } catch { Write-Warning "Immediate cleanup request failed: $($_.Exception.Message)" }
  }
  throw $launchError
} finally {
  if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
}

if (-not $Wait) { return [pscustomobject]@{ JobId = $created.job.id; Provider = $resolved; EstimatedCostKRW = $estimate.total } }
$jobId = $created.job.id
$jobDirectory = Join-Path $DownloadDirectory $jobId
$deadline = [DateTimeOffset]::UtcNow.AddMinutes($Minutes + 25)
$lastProgress = ''
$timedOut = $false
do {
  $job = Get-CclJob $jobId
  if (-not $job) { throw "Job disappeared: $jobId" }
  $progress = "$($job.status)/$($job.stage)"
  if ($progress -ne $lastProgress) { Write-Host "Job ${jobId}: $progress"; $lastProgress = $progress }
  $terminal = @('completed', 'failed', 'cancelled') -contains $job.status
  $instanceCleanupVerified = -not $job.instance_id -or $job.instance_deleted_at
  $publicIpCleanupVerified = -not $job.public_ip_id -or $job.public_ip_removed_at
  $cleanupVerified = $terminal -and $instanceCleanupVerified -and $publicIpCleanupVerified -and (-not $job.cleanup_error)
  if ($cleanupVerified) { break }
  if ([DateTimeOffset]::UtcNow -ge $deadline -and -not $timedOut) {
    $timedOut = $true
    Write-Warning "Job deadline exceeded; cancelling $jobId."
    $null = Invoke-CclJson '/api/jobs?action=cancel' 'POST' @{ id = $jobId }
    $deadline = [DateTimeOffset]::UtcNow.AddMinutes(20)
  } elseif ([DateTimeOffset]::UtcNow -ge $deadline) { throw "Cleanup verification timed out for job $jobId." }
  Start-Sleep -Seconds $PollSeconds
} while ($true)

$usage = Invoke-CclJson '/api/usage'
Write-JobEvidence $job $estimate $jobDirectory $usage
if ($job.log_key) { Invoke-WebRequest -Uri "$BaseUrl/api/jobs?action=log&id=$jobId" -WebSession $session -OutFile (Join-Path $jobDirectory 'run.log') -UseBasicParsing | Out-Null }
if ($job.result_key) {
  $resultUrl = Invoke-CclJson "/api/jobs?action=result-url&id=$jobId"
  Invoke-WebRequest -Uri $resultUrl.url -OutFile (Join-Path $jobDirectory 'result.tar.gz') -UseBasicParsing | Out-Null
}
if ($DeleteRemoteArtifacts) {
  $remoteKeys = @($job.code_key, $job.data_key, $job.result_key, $job.log_key, $job.preview_key, $job.manifest_key) | Where-Object { $_ } | Select-Object -Unique
  foreach ($remoteKey in $remoteKeys) {
    try { $null = Invoke-CclJson ("/api/ncp-storage?action=object&bucket={0}&key={1}" -f [uri]::EscapeDataString($job.bucket), [uri]::EscapeDataString($remoteKey)) 'DELETE' }
    catch { Write-Warning "Remote artifact cleanup failed for one object: $($_.Exception.Message)" }
  }
}
Write-Host "Artifacts: $jobDirectory"
Write-Host ("Actual cost: {0:N2} KRW; remaining {1}: {2:N2} KRW; instance/public-IP cleanup: verified" -f $job.usage_amount, $resolved, $usage.remaining.$resolved)
if ($timedOut) { throw "GPU job timed out and was cancelled: $jobId" }
if ($job.status -ne 'completed') { throw "GPU job ended with status $($job.status): $($job.error)" }
return [pscustomobject]@{ JobId = $jobId; Provider = $resolved; Status = $job.status; EstimatedCostKRW = $estimate.total; ActualCostKRW = $job.usage_amount; RemainingCreditKRW = $usage.remaining.$resolved; ArtifactPath = $jobDirectory; CleanupVerified = $true }
