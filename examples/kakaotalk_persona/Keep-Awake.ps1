[CmdletBinding()]
param(
  [string]$RunnerRoot = 'C:\dev\cloud-gpu-runner',
  [ValidateRange(12, 36)][int]$MaximumHours = 24
)

$source = @'
using System;
using System.Runtime.InteropServices;
public static class CampaignPower {
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
'@
Add-Type -TypeDefinition $source
$continuous = 0x80000000
$systemRequired = 0x00000001
[void][CampaignPower]::SetThreadExecutionState($continuous -bor $systemRequired)
try {
  $ready = Join-Path $RunnerRoot 'etc\kakaotalk-persona\local-ready.json'
  $deadline = (Get-Date).AddHours($MaximumHours)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $ready) {
      $state = Get-Content -LiteralPath $ready -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($state.Ready -eq $true) { break }
    }
    Start-Sleep -Seconds 60
  }
} finally {
  [void][CampaignPower]::SetThreadExecutionState($continuous)
}
