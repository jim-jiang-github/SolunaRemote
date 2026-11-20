param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,
    [switch]$MicrosoftStore
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$output = [IO.Path]::GetFullPath($OutputDirectory)
$openssl = Join-Path $root 'native\build\vcpkg_installed\x64-windows-release'
$native = Join-Path $root 'native\bin'
$hostSource = Join-Path $root 'host\bin'
$prepared = Join-Path $root 'src-tauri\resources'

if (Test-Path -LiteralPath $output) {
    throw "Output directory already exists: $output"
}
foreach ($file in @(
    (Join-Path $openssl 'include\openssl\ssl.h'),
    (Join-Path $native 'soluna-stream.exe'),
    (Join-Path $native 'vcruntime140.dll'),
    (Join-Path $hostSource 'sunshine.exe'),
    (Join-Path $prepared 'native\soluna-stream.exe'),
    (Join-Path $prepared 'host\sunshine.exe'),
    (Join-Path $prepared 'host-tools\host-firewall.ps1')
)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Required build input is missing: $file"
    }
}
foreach ($name in @('libssl-3-x64.dll', 'libcrypto-3-x64.dll')) {
    $buildDll = Join-Path $openssl "bin\$name"
    $nativeDll = Join-Path $native $name
    if (-not (Test-Path -LiteralPath $buildDll -PathType Leaf) -or
        -not (Test-Path -LiteralPath $nativeDll -PathType Leaf)) {
        throw "Required OpenSSL DLL is missing: $name"
    }
    if ((Get-FileHash -LiteralPath $buildDll).Hash -ne (Get-FileHash -LiteralPath $nativeDll).Hash) {
        throw "Native and Rust OpenSSL DLLs differ: $name"
    }
}

$env:OPENSSL_DIR = $openssl
$target = Join-Path $root 'src-tauri\target'
$buildArguments = @('build', '--release', '--locked', '--manifest-path', (Join-Path $root 'src-tauri\Cargo.toml'))
if ($MicrosoftStore) {
    $target = Join-Path $target 'microsoft-store'
    $buildArguments += @('--features', 'microsoft-store')
}
$buildArguments += @('--target-dir', $target)
& cargo @buildArguments
if ($LASTEXITCODE -ne 0) { throw 'Rust release build failed.' }

New-Item -ItemType Directory -Path $output | Out-Null
Copy-Item -LiteralPath (Join-Path $target 'release\solunaremote.exe') `
    -Destination (Join-Path $output 'SolunaRemote.exe')
foreach ($name in @('libssl-3-x64.dll', 'libcrypto-3-x64.dll', 'vcruntime140.dll')) {
    Copy-Item -LiteralPath (Join-Path $native $name) -Destination $output
}
$resources = Join-Path $output 'resources'
New-Item -ItemType Directory -Path $resources | Out-Null
Copy-Item -LiteralPath $native -Destination (Join-Path $resources 'native') -Recurse
$hostDestination = Join-Path $resources 'host'
New-Item -ItemType Directory -Path $hostDestination | Out-Null
Get-ChildItem -LiteralPath $hostSource -Force |
    Where-Object { $_.Name -ne 'config' -and (-not $MicrosoftStore -or $_.Name -notin @('scripts', 'tools')) } |
    Copy-Item -Destination $hostDestination -Recurse
if (-not $MicrosoftStore) {
    New-Item -ItemType Directory -Path (Join-Path $resources 'host-tools') | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'app\host-firewall.ps1') `
        -Destination (Join-Path $resources 'host-tools')
}
Write-Output "Direct-run application: $output\SolunaRemote.exe"
