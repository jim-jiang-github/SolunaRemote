param(
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [string]$MsysRoot = 'C:\msys64'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) {
    throw "Output directory already exists: $output"
}
$ucrt = Join-Path $MsysRoot 'ucrt64'
$bin = Join-Path $ucrt 'bin'
foreach ($tool in @('gcc.exe', 'g++.exe', 'ar.exe', 'cmake.exe', 'ninja.exe', 'pkg-config.exe', 'objdump.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $bin $tool) -PathType Leaf)) {
        throw "Missing MSYS2 UCRT64 tool: $tool"
    }
}
$env:PATH = "$bin;$(Join-Path $MsysRoot 'usr\bin');$env:PATH"
$env:OPENSSL_DIR = $ucrt
$env:OPENSSL_LIB_DIR = Join-Path $ucrt 'lib'
$env:OPENSSL_INCLUDE_DIR = Join-Path $ucrt 'include'
$env:CC = Join-Path $bin 'gcc.exe'
$env:AR = Join-Path $bin 'ar.exe'
$env:CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = Join-Path $bin 'g++.exe'
if (Test-Path Env:\GIT_EXEC_PATH) { Remove-Item Env:\GIT_EXEC_PATH }

$sunshine = Join-Path $root 'third-party\Sunshine'
$sunshineBuild = Join-Path $sunshine 'cmake-build-ucrt64'
$nativeBuild = Join-Path $root 'native\build-embedded-ucrt64'
& cmake -S $sunshine -B $sunshineBuild -G Ninja '-DCMAKE_BUILD_TYPE=Release' `
    '-DSUNSHINE_BUILD_EMBEDDED=ON' '-DSUNSHINE_ENABLE_TRAY=OFF' `
    '-DBUILD_DOCS=OFF' '-DBUILD_TESTS=OFF' '-DDOTNET_EXECUTABLE='
if ($LASTEXITCODE -ne 0) { throw 'Sunshine configuration failed.' }
& cmake --build $sunshineBuild --target sunshine_embedded --parallel 4
if ($LASTEXITCODE -ne 0) { throw 'Sunshine embedded build failed.' }

$ffmpegPackages = @(Get-ChildItem -LiteralPath (Join-Path $sunshineBuild '_deps') -Directory -Filter 'ffmpeg-*' |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'ffmpeg\lib\pkgconfig\libavcodec.pc') })
if ($ffmpegPackages.Count -ne 1) {
    throw 'Expected exactly one Sunshine FFmpeg dependency in the build directory.'
}
$ffmpegRoot = Join-Path $ffmpegPackages[0].FullName 'ffmpeg'
$env:PKG_CONFIG_PATH = Join-Path $ffmpegRoot 'lib\pkgconfig'
$nativeArguments = @('-S', (Join-Path $root 'native'), '-B', $nativeBuild, '-G', 'Ninja',
    '-DCMAKE_BUILD_TYPE=Release', '-DSOLUNA_BUILD_EMBEDDED=ON')
$existingMoonlight = Join-Path $root 'native\build\_deps\moonlight-src'
if (Test-Path -LiteralPath (Join-Path $existingMoonlight '.git')) {
    $revision = & git -C $existingMoonlight rev-parse HEAD
    if ($LASTEXITCODE -eq 0 -and $revision -eq 'd5b38a3ac63927a11bebd8337df024f11eba34d5') {
        $nativeArguments += "-DFETCHCONTENT_SOURCE_DIR_MOONLIGHT=$existingMoonlight"
    }
}
& cmake @nativeArguments
if ($LASTEXITCODE -ne 0) { throw 'Native client configuration failed.' }
& cmake --build $nativeBuild --target soluna-stream --parallel 4
if ($LASTEXITCODE -ne 0) { throw 'Native client embedded build failed.' }

& cargo +stable-x86_64-pc-windows-gnu build --release --locked `
    --manifest-path (Join-Path $root 'src-tauri\Cargo.toml') `
    --target x86_64-pc-windows-gnu --features embedded-sunshine
if ($LASTEXITCODE -ne 0) { throw 'Integrated application build failed.' }

$release = Join-Path $root 'src-tauri\target\x86_64-pc-windows-gnu\release'
New-Item -ItemType Directory -Path $output | Out-Null
$exe = Join-Path $output 'solunaremote.exe'
Copy-Item -LiteralPath (Join-Path $release 'solunaremote.exe') -Destination $exe
$hostDll = Join-Path $output 'soluna-host.dll'
$streamDll = Join-Path $output 'soluna-stream.dll'
Copy-Item -LiteralPath (Join-Path $sunshineBuild 'soluna-host.dll') -Destination $hostDll
Copy-Item -LiteralPath (Join-Path $nativeBuild 'soluna-stream.dll') -Destination $streamDll
$hostDirectory = Join-Path $output 'resources\host'
$hostAssets = Join-Path $hostDirectory 'assets'
New-Item -ItemType Directory -Path $hostAssets -Force | Out-Null
$sourceAssets = Join-Path $sunshineBuild 'assets'
Copy-Item -LiteralPath (Join-Path $sourceAssets 'shaders') -Destination $hostAssets -Recurse
foreach ($image in @('box.png', 'desktop.png')) {
    Copy-Item -LiteralPath (Join-Path $sourceAssets $image) -Destination $hostAssets
}
$licenseDirectory = Join-Path $output 'licenses'
New-Item -ItemType Directory -Path $licenseDirectory | Out-Null
Copy-Item -LiteralPath (Join-Path $sunshine 'LICENSE') -Destination (Join-Path $licenseDirectory 'Sunshine-LICENSE')
Copy-Item -LiteralPath (Join-Path $ffmpegRoot 'share') -Destination (Join-Path $licenseDirectory 'ffmpeg-share') -Recurse

$pending = [Collections.Generic.Queue[string]]::new()
$pending.Enqueue($exe)
$pending.Enqueue($hostDll)
$pending.Enqueue($streamDll)
$seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
while ($pending.Count -gt 0) {
    $binary = $pending.Dequeue()
    $imports = & (Join-Path $bin 'objdump.exe') -p $binary
    if ($LASTEXITCODE -ne 0) { throw "Cannot inspect DLL dependencies: $binary" }
    foreach ($line in $imports) {
        if ($line -notmatch 'DLL Name:\s*(\S+)') { continue }
        $name = $Matches[1]
        if (-not $seen.Add($name)) { continue }
        $source = Join-Path $release $name
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { $source = Join-Path $bin $name }
        if (Test-Path -LiteralPath $source -PathType Leaf) {
            $destination = Join-Path $output $name
            Copy-Item -LiteralPath $source -Destination $destination
            $pending.Enqueue($destination)
        } elseif ($name -notmatch '^(api-ms-win-|ext-ms-win-)' -and
                  -not (Test-Path -LiteralPath (Join-Path $env:SystemRoot "System32\$name") -PathType Leaf)) {
            throw "Cannot locate runtime DLL: $name"
        }
    }
}
Write-Output "Integrated application: $exe"
