param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('dev', 'build')]
    [string]$Mode
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
& (Join-Path $PSScriptRoot 'prepare-tauri.ps1')
Push-Location (Join-Path $root 'src-tauri')
try {
    if ($Mode -eq 'dev') {
        cargo tauri dev
    } else {
        cargo tauri build --bundles nsis
    }
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}
