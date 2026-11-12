$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$resources = Join-Path $root 'src-tauri\resources'

if (Test-Path -LiteralPath $resources) {
    Remove-Item -LiteralPath $resources -Recurse -Force
}
New-Item -ItemType Directory -Path $resources | Out-Null
Copy-Item -LiteralPath (Get-Command node).Source -Destination (Join-Path $resources 'node.exe')
Copy-Item -LiteralPath (Join-Path $root 'app') -Destination (Join-Path $resources 'app') -Recurse
Copy-Item -LiteralPath (Join-Path $root 'native\bin') -Destination (Join-Path $resources 'native') -Recurse
$hostSource = Join-Path $root 'host\bin'
$hostDestination = Join-Path $resources 'host'
New-Item -ItemType Directory -Path $hostDestination | Out-Null
Get-ChildItem -LiteralPath $hostSource -Force |
    Where-Object { $_.Name -ne 'config' } |
    Copy-Item -Destination $hostDestination -Recurse
New-Item -ItemType Directory -Path (Join-Path $resources 'node_modules') | Out-Null

$copied = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
function Copy-ProductionDependency([string]$name) {
    if (-not $copied.Add($name)) { return }
    $relative = $name.Replace('/', '\')
    $source = Join-Path $root "node_modules\$relative"
    if (-not (Test-Path -LiteralPath (Join-Path $source 'package.json'))) {
        throw "Missing production dependency: $name"
    }
    $destination = Join-Path $resources "node_modules\$relative"
    New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Recurse
    $manifest = Get-Content -LiteralPath (Join-Path $source 'package.json') -Raw | ConvertFrom-Json
    foreach ($dependency in $manifest.dependencies.PSObject.Properties.Name) {
        Copy-ProductionDependency $dependency
    }
}

$application = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
foreach ($dependency in $application.dependencies.PSObject.Properties.Name) {
    Copy-ProductionDependency $dependency
}
Write-Output "Prepared Tauri resources: $resources"
