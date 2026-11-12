$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path $PSScriptRoot -Parent
$version = 'v2026.914.233613'
$expected = '233008e46f4c0e501a586cbfd6c4fd4a4c0d414a0b5fc7f13c070eb92ec3824b'
$destination = Join-Path $root 'host\bin'
$marker = Join-Path $destination 'release.json'
if (Test-Path -LiteralPath $marker) {
    $release = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    if ($release.version -eq $version -and $release.sha256 -eq $expected -and
        (Test-Path -LiteralPath (Join-Path $destination 'sunshine.exe'))) {
        Write-Output "Bundled host already prepared: $version"
        exit 0
    }
    throw 'Existing host bundle differs. Inspect it before replacing files.'
}
if (Test-Path -LiteralPath $destination) {
    throw 'Host bundle directory already exists without a release manifest.'
}
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('lan-host-' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
    $archive = Join-Path $temporary 'sunshine.zip'
    Invoke-WebRequest -UseBasicParsing `
        -Uri "https://github.com/SunshineStream/Sunshine/releases/download/$version/Sunshine-Windows-AMD64-lite.zip" `
        -OutFile $archive
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) {
        throw 'Official Sunshine release SHA256 mismatch.'
    }
    $expanded = Join-Path $temporary 'expanded'
    Expand-Archive -LiteralPath $archive -DestinationPath $expanded
    $source = Join-Path $expanded 'Sunshine'
    if (-not (Test-Path -LiteralPath (Join-Path $source 'sunshine.exe'))) {
        throw 'Official portable archive layout is incompatible.'
    }
    New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
    Move-Item -LiteralPath $source -Destination $destination
    New-Item -ItemType Directory -Path (Join-Path $destination 'licenses') | Out-Null
    Invoke-WebRequest -UseBasicParsing `
        -Uri "https://raw.githubusercontent.com/SunshineStream/Sunshine/$version/LICENSE" `
        -OutFile (Join-Path $destination 'licenses\Sunshine-LICENSE')
    Copy-Item -LiteralPath (Join-Path $root 'host\THIRD-PARTY-NOTICES.txt') `
        -Destination (Join-Path $destination 'THIRD-PARTY-NOTICES.txt')
    @{ version = $version; sha256 = $expected; source = "https://github.com/SunshineStream/Sunshine/tree/$version" } |
        ConvertTo-Json | Set-Content -LiteralPath $marker -Encoding ascii
    Write-Output "Prepared bundled Sunshine host: $version"
} finally {
    if (Test-Path -LiteralPath $temporary) {
        Remove-Item -LiteralPath $temporary -Recurse -Force
    }
}
