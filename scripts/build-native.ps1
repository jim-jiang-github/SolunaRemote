param([string]$VcpkgRoot = $env:VCPKG_ROOT)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw 'Visual Studio C++ build tools are required.' }
$cmake = Join-Path $vs 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
if (-not $VcpkgRoot) {
    $VcpkgRoot = Join-Path $root 'native\.tools\vcpkg'
    if (-not (Test-Path -LiteralPath (Join-Path $VcpkgRoot '.git'))) {
        git clone --quiet https://github.com/microsoft/vcpkg.git $VcpkgRoot
        if ($LASTEXITCODE) { throw 'Unable to clone vcpkg.' }
    }
}
if (-not (Test-Path -LiteralPath (Join-Path $VcpkgRoot 'vcpkg.exe'))) {
    & (Join-Path $VcpkgRoot 'bootstrap-vcpkg.bat') -disableMetrics
    if ($LASTEXITCODE) { throw 'Unable to bootstrap vcpkg.' }
}
$env:VCPKG_DISABLE_METRICS = '1'
& $cmake -S (Join-Path $root 'native') -B (Join-Path $root 'native\build') `
    "-DCMAKE_TOOLCHAIN_FILE=$VcpkgRoot\scripts\buildsystems\vcpkg.cmake" `
    "-DVCPKG_OVERLAY_TRIPLETS=$root\native\triplets" `
    -DVCPKG_TARGET_TRIPLET=x64-windows-release -A x64
if ($LASTEXITCODE) { throw 'Native configure or dependency build failed.' }
& $cmake --build (Join-Path $root 'native\build') --config Release --parallel
if ($LASTEXITCODE) { throw 'Native build failed.' }
$output = Join-Path $root 'native\bin'
New-Item -ItemType Directory -Path $output -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'native\build\Release\soluna-stream.exe') -Destination $output -Force
Get-ChildItem -LiteralPath (Join-Path $root 'native\build\vcpkg_installed\x64-windows-release\bin') -Filter '*.dll' |
    Copy-Item -Destination $output -Force
$redist = Get-ChildItem -LiteralPath (Join-Path $vs 'VC\Redist\MSVC') -Directory |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } |
    Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (-not $redist) { throw 'MSVC redistributable runtime directory is missing.' }
$crt = Get-ChildItem -LiteralPath (Join-Path $redist.FullName 'x64') -Directory |
    Where-Object { $_.Name -match '^Microsoft\.VC\d+\.CRT$' } | Select-Object -First 1
if (-not $crt) { throw 'x64 MSVC redistributable CRT directory is missing.' }
Get-ChildItem -LiteralPath $crt.FullName -Filter '*.dll' | Copy-Item -Destination $output -Force
$licenseOutput = Join-Path $output 'licenses'
New-Item -ItemType Directory -Path $licenseOutput -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'native\THIRD-PARTY-NOTICES.txt') -Destination $licenseOutput -Force
Get-ChildItem -LiteralPath (Join-Path $root 'native\build\vcpkg_installed\x64-windows-release\share') -Directory | ForEach-Object {
    $copyright = Join-Path $_.FullName 'copyright'
    if (Test-Path -LiteralPath $copyright) { Copy-Item -LiteralPath $copyright -Destination (Join-Path $licenseOutput "$($_.Name).txt") -Force }
}
Copy-Item -LiteralPath (Join-Path $root 'native\build\_deps\moonlight-src\LICENSE.txt') -Destination (Join-Path $licenseOutput 'moonlight-common-c.txt') -Force
foreach ($dependency in @('enet', 'nanors')) {
    $source = Join-Path $root "native\build\_deps\moonlight-src\$dependency"
    Get-ChildItem -LiteralPath $source -File | Where-Object { $_.Name -match '^(LICENSE|COPYING|COPYRIGHT)' } | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $licenseOutput "$dependency-$($_.Name).txt") -Force
    }
}
Write-Output "Native engine built: $output\soluna-stream.exe"
