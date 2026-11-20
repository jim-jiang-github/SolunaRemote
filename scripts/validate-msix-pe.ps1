param(
    [Parameter(Mandatory = $true)]
    [string]$PackageDirectory,
    [switch]$RepairKnownSunshineCertificate
)

$ErrorActionPreference = 'Stop'
$directory = (Get-Item -LiteralPath $PackageDirectory -ErrorAction Stop).FullName
$count = 0
foreach ($file in Get-ChildItem -LiteralPath $directory -Recurse -File |
    Where-Object { $_.Extension -in @('.exe', '.dll') }) {
    $stream = [IO.File]::OpenRead($file.FullName)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        if ($stream.Length -lt 64 -or $reader.ReadUInt16() -ne 0x5A4D) {
            throw "Invalid DOS header: $($file.FullName)"
        }
        $stream.Position = 0x3C
        $pe = $reader.ReadUInt32()
        if ([long]$pe + 24 -gt $stream.Length) { throw "Invalid PE offset: $($file.FullName)" }
        $stream.Position = $pe
        if ($reader.ReadUInt32() -ne 0x4550) { throw "Invalid PE header: $($file.FullName)" }
        if ($reader.ReadUInt16() -ne 0x8664) { throw "MSIX requires x64 PE files: $($file.FullName)" }
        $stream.Position = $pe + 20
        $optionalSize = $reader.ReadUInt16()
        $optional = [long]$pe + 24
        if ($optionalSize -lt 152 -or $optional + $optionalSize -gt $stream.Length) {
            throw "Invalid optional header: $($file.FullName)"
        }
        $stream.Position = $optional
        if ($reader.ReadUInt16() -ne 0x20B) { throw "Expected PE32+ header: $($file.FullName)" }
        $stream.Position = $optional + 108
        if ($reader.ReadUInt32() -lt 5) { throw "Missing PE data directories: $($file.FullName)" }
        $securityOffset = $optional + 144
        $stream.Position = $securityOffset
        $certificateOffset = $reader.ReadUInt32()
        $certificateSize = $reader.ReadUInt32()
        $invalid = ($certificateOffset -eq 0) -ne ($certificateSize -eq 0)
        if ($certificateOffset -ne 0) {
            $invalid = $invalid -or $certificateSize -lt 8 -or ($certificateOffset % 8) -ne 0 -or
                ([long]$certificateOffset + $certificateSize) -gt $stream.Length -or
                $certificateOffset -lt ($optional + $optionalSize)
        }
    } finally {
        $reader.Dispose()
    }
    if ($invalid) {
        $relative = $file.FullName.Substring($directory.Length).TrimStart('\')
        $known = $RepairKnownSunshineCertificate -and
            $relative -eq 'resources\host\sunshine.exe' -and
            $file.Length -eq 70910996 -and
            $certificateOffset -eq 348693688 -and $certificateSize -eq 15624 -and
            (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -eq
                'A8DDF74E93297529CA5AA9C59234A7043B94587E8D11EA24C521FA69D6F59FD3'
        if (-not $known) { throw "Invalid PE certificate directory: $($file.FullName)" }
        # This hash-verified upstream lite EXE points outside the file; no certificate exists there.
        $stream = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Write)
        try {
            $stream.Position = $securityOffset
            $stream.Write([byte[]]::new(8), 0, 8)
            $stream.Flush()
        } finally {
            $stream.Dispose()
        }
        Write-Warning "Cleared the known dangling Sunshine PE certificate directory in package staging only: $relative"
    }
    $count++
}
Write-Output "Validated $count x64 PE certificate directory ranges."
