param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('dev', 'build')]
    [string]$Mode
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
& (Join-Path $PSScriptRoot 'prepare-tauri.ps1')
if ($env:OS -eq 'Windows_NT') {
    $opensslRoot = Join-Path $root 'native\build\vcpkg_installed\x64-windows-release'
    if (-not (Test-Path -LiteralPath (Join-Path $opensslRoot 'include\openssl\ssl.h'))) {
        throw 'The native build must install the OpenSSL headers before building the Rust app.'
    }
    $env:OPENSSL_DIR = $opensslRoot
}
Push-Location (Join-Path $root 'src-tauri')
try {
    if ($Mode -eq 'dev') {
        npx.cmd --no-install tauri dev
    } else {
        npx.cmd --no-install tauri build --bundles nsis
    }
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}
