$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$resources = Join-Path $root 'src-tauri\resources'

if (Test-Path -LiteralPath $resources) {
    Remove-Item -LiteralPath $resources -Recurse -Force
}
New-Item -ItemType Directory -Path $resources | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'native\bin') -Destination (Join-Path $resources 'native') -Recurse
$hostSource = Join-Path $root 'host\bin'
$hostDestination = Join-Path $resources 'host'
New-Item -ItemType Directory -Path $hostDestination | Out-Null
Get-ChildItem -LiteralPath $hostSource -Force |
    Where-Object { $_.Name -ne 'config' } |
    Copy-Item -Destination $hostDestination -Recurse
$hostTools = Join-Path $resources 'host-tools'
New-Item -ItemType Directory -Path $hostTools | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'app\host-firewall.ps1') -Destination $hostTools
Write-Output "Prepared native Tauri resources (no Node.js runtime): $resources"
