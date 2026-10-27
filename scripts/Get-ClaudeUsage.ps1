<#
.SYNOPSIS
  Shows the team's Claude Code usage from the collector, in PowerShell.
.EXAMPLE
  .\Get-ClaudeUsage.ps1 -Collector http://94.103.163.147:4318 -Key READ_KEY
  .\Get-ClaudeUsage.ps1 -Collector http://94.103.163.147:4318 -Key READ_KEY -Days 30 -PC harsh
.NOTES
  Works in Windows PowerShell 5.1 and PowerShell 7. The key is READ_KEY (or INGEST_KEY) from the collector.
  USAGE_URL / USAGE_READ_KEY / USAGE_KEY from the environment are used when the parameters are left out.
#>
param(
  [string]$Collector = $env:USAGE_URL,
  [string]$Key = $(if ($env:USAGE_READ_KEY) { $env:USAGE_READ_KEY } else { $env:USAGE_KEY }),
  [int]$Days = 7,
  [string]$PC = '',
  [switch]$Daily
)
if (-not $Collector) { throw 'Give -Collector (the collector address) or set USAGE_URL.' }
if (-not $Key) { throw 'Give -Key (READ_KEY or INGEST_KEY from the collector) or set USAGE_READ_KEY.' }
$Collector = $Collector.TrimEnd('/')
try { $feed = Invoke-RestMethod -Uri "$Collector/api/usage" -Headers @{ 'x-read-key' = $Key } -TimeoutSec 30 }
catch { throw "Could not read $Collector/api/usage : $($_.Exception.Message)" }
if (-not $feed.ok) { throw 'The collector did not return a usage feed.' }

$since = (Get-Date).AddDays(1 - $Days).ToString('yyyy-MM-dd')
function Sum($rows, $i) { [double](($rows | ForEach-Object { $_[$i] } | Measure-Object -Sum).Sum) }
$members = @($feed.members | Where-Object { -not $PC -or $_.label -like "*$PC*" -or $_.id -like "*$PC*" })
if (-not $members.Count) { Write-Host "No PC matches '$PC'. PCs on the collector: $(@($feed.members | ForEach-Object { $_.label }) -join ', ')"; return }

Write-Host ("Claude Code usage from {0} to today ({1}), {2} PC(s). Costs are API list-price estimates." -f $since, $feed.tz, $members.Count)
$perPc = foreach ($m in $members) {
  $rows = @($m.rows | Where-Object { $_[0] -ge $since })
  [pscustomobject]@{
    PC = $m.label
    'Cost $' = [math]::Round((Sum $rows 6), 2)
    Input = [int64](Sum $rows 2)
    Output = [int64](Sum $rows 3)
    'Cache write' = [int64](Sum $rows 4)
    'Cache read' = [int64](Sum $rows 5)
    'Active days' = @($rows | ForEach-Object { $_[0] } | Sort-Object -Unique).Count
    'Last seen' = $(if ($m.lastSeen) { ([datetime]$m.lastSeen).ToLocalTime().ToString('yyyy-MM-dd HH:mm') } else { '' })
    Source = $m.source
  }
}
$perPc | Sort-Object 'Cost $' -Descending | Format-Table -AutoSize | Out-String -Width 200 | Write-Host

$allRows = @($members | ForEach-Object { $_.rows } | Where-Object { $_[0] -ge $since })
Write-Host ("Total: {0:N2} USD, {1:N0} output tokens, {2:N0} cache-read tokens" -f (Sum $allRows 6), (Sum $allRows 3), (Sum $allRows 5))
Write-Host 'By model:'
$allRows | Group-Object { $_[1] } | ForEach-Object {
  [pscustomobject]@{ Model = $_.Name; 'Cost $' = [math]::Round((Sum $_.Group 6), 2); Output = [int64](Sum $_.Group 3); 'Cache read' = [int64](Sum $_.Group 5) }
} | Sort-Object 'Cost $' -Descending | Format-Table -AutoSize | Out-String -Width 200 | Write-Host

if ($Daily) {
  Write-Host 'By day:'
  $allRows | Group-Object { $_[0] } | Sort-Object Name | ForEach-Object {
    [pscustomobject]@{ Day = $_.Name; 'Cost $' = [math]::Round((Sum $_.Group 6), 2); Output = [int64](Sum $_.Group 3); Models = (@($_.Group | ForEach-Object { $_[1] } | Sort-Object -Unique) -join ', ') }
  } | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
}
if ($feed.stats.lastEvent) { Write-Host ("Last usage received by the collector: {0}" -f ([datetime]$feed.stats.lastEvent).ToLocalTime().ToString('yyyy-MM-dd HH:mm')) }
