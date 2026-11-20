[CmdletBinding(DefaultParameterSetName = 'Store')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Store')]
    [ValidatePattern('^[A-Za-z0-9.-]{3,50}$')]
    [string]$IdentityName,
    [Parameter(Mandatory = $true, ParameterSetName = 'Store')]
    [ValidateNotNullOrEmpty()]
    [string]$Publisher,
    [Parameter(Mandatory = $true, ParameterSetName = 'Store')]
    [ValidateNotNullOrEmpty()]
    [string]$PublisherDisplayName,
    [Parameter(Mandatory = $true, ParameterSetName = 'Preview')]
    [switch]$Preview,
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,
    [string]$Version
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) {
    throw "Output directory already exists: $output"
}
if ($Preview) {
    $IdentityName = 'SolunaRemote.Preview'
    $Publisher = 'CN=SolunaRemote Preview'
    $PublisherDisplayName = 'SolunaRemote Preview'
} elseif ($IdentityName -eq 'SolunaRemote.Preview' -or $Publisher -eq 'CN=SolunaRemote Preview') {
    throw 'Preview identity cannot be used for a Store submission.'
}
if ($Publisher -notmatch '^CN=' -or $Publisher.Contains('OID.2.25.311729368913984317654407730594956997722')) {
    throw 'Copy the exact Package/Identity/Publisher value from Partner Center.'
}
$null = [Security.Cryptography.X509Certificates.X500DistinguishedName]::new($Publisher)
$package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
if (-not $Version) { $Version = "$($package.version).0" }
if ($Version -notmatch '^\d+\.\d+\.\d+\.0$') {
    throw 'Store package version must have four numeric parts with the last part set to 0.'
}
$parts = $Version.Split('.') | ForEach-Object { [int]$_ }
if ($parts | Where-Object { $_ -gt 65535 }) {
    throw 'Each package version component must be between 0 and 65535.'
}
if (-not $Preview -and $parts[0] -eq 0) {
    throw 'Store package major version must be greater than 0. Pass -Version 1.0.0.0 or a newer Store version.'
}
$makeAppx = Get-Command makeappx.exe -ErrorAction SilentlyContinue
if ($makeAppx) {
    $makeAppxPath = $makeAppx.Source
} else {
    $sdk = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $makeAppxPath = Get-ChildItem -LiteralPath $sdk -Directory |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
        Sort-Object { [version]$_.Name } -Descending |
        ForEach-Object { Join-Path $_.FullName 'x64\makeappx.exe' } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        Select-Object -First 1
}
if (-not $makeAppxPath) {
    throw 'MakeAppx.exe is missing. Install the Windows 11 SDK.'
}

& (Join-Path $PSScriptRoot 'prepare-tauri.ps1')
New-Item -ItemType Directory -Path $output | Out-Null
$layout = Join-Path $output 'layout'
& (Join-Path $PSScriptRoot 'build-direct.ps1') -OutputDirectory $layout -MicrosoftStore
$hostConfig = Join-Path $layout 'resources\host\config'
New-Item -ItemType Directory -Path $hostConfig | Out-Null
New-Item -ItemType File -Path (Join-Path $hostConfig '.keep') | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination $layout
$assets = Join-Path $layout 'Assets'
New-Item -ItemType Directory -Path $assets | Out-Null
foreach ($icon in @('Square150x150Logo.png', 'Square44x44Logo.png', 'StoreLogo.png')) {
    Copy-Item -LiteralPath (Join-Path $root "src-tauri\icons\$icon") -Destination $assets
}

$manifest = [xml](Get-Content -LiteralPath (Join-Path $root 'packaging\msix\AppxManifest.xml') -Raw)
$manifest.Package.Identity.SetAttribute('Name', $IdentityName)
$manifest.Package.Identity.SetAttribute('Publisher', $Publisher)
$manifest.Package.Identity.SetAttribute('Version', $Version)
$manifest.Package.Properties.PublisherDisplayName = $PublisherDisplayName
if ($Preview) {
    $manifest.Package.Properties.DisplayName = 'SolunaRemote (Store preview)'
}
$manifestPath = Join-Path $layout 'AppxManifest.xml'
$settings = [Xml.XmlWriterSettings]::new()
$settings.Encoding = [Text.UTF8Encoding]::new($false)
$settings.Indent = $true
$writer = [Xml.XmlWriter]::Create($manifestPath, $settings)
try { $manifest.Save($writer) } finally { $writer.Dispose() }

$label = if ($Preview) { 'preview' } else { 'store' }
$msix = Join-Path $output "SolunaRemote-$Version-x64-$label.msix"
& (Join-Path $PSScriptRoot 'validate-msix-pe.ps1') -PackageDirectory $layout -RepairKnownSunshineCertificate
& $makeAppxPath pack /d $layout /p $msix /o /l
if ($LASTEXITCODE -ne 0) { throw 'MSIX packing or manifest validation failed.' }
Write-Output "Unsigned MSIX: $msix"
Write-Output "SHA256: $((Get-FileHash -LiteralPath $msix -Algorithm SHA256).Hash)"
if ($Preview) {
    Write-Warning 'PREVIEW ONLY: this package has no Partner Center identity or signature. Do not upload it to the Store or distribute it as an installable release.'
} else {
    Write-Output 'Submit this unsigned MSIX through the matching Partner Center product. Store certification and installed-package testing are still required.'
}
