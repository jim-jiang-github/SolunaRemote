$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if ($env:OS -eq 'Windows_NT' -and -not $env:OPENSSL_DIR) {
    $env:OPENSSL_DIR = Join-Path $root 'native\build\vcpkg_installed\x64-windows-release'
}
& cargo test --manifest-path (Join-Path $root 'src-tauri\Cargo.toml')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
