param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$AppExecutable
)
$ErrorActionPreference = 'Stop'
function Normalize-ExecutablePath([string]$Path) {
    if ($Path.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) {
        return '\\' + $Path.Substring(8)
    }
    if ($Path.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase)) {
        return $Path.Substring(4)
    }
    return $Path
}
try {
    $Executable = Normalize-ExecutablePath $Executable
    $AppExecutable = Normalize-ExecutablePath $AppExecutable
    if (-not [IO.Path]::IsPathRooted($Executable) -or
        -not (Test-Path -LiteralPath $Executable -PathType Leaf) -or
        [IO.Path]::GetFileName($Executable) -ne 'sunshine.exe') {
        throw 'Invalid bundled host executable.'
    }
    if (-not [IO.Path]::IsPathRooted($AppExecutable) -or
        -not (Test-Path -LiteralPath $AppExecutable -PathType Leaf)) {
        throw 'Invalid SolunaRemote executable.'
    }
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $digest = $hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($AppExecutable).ToLowerInvariant()))
        $suffix = ([BitConverter]::ToString($digest) -replace '-', '').Substring(0, 16)
    } finally { $hasher.Dispose() }
    $rules = @(
        @{ Name = "SolunaRemote-Integrated-TCP-$suffix"; Protocol = 'TCP'; Ports = @(47984, 47989, 48010); Program = $Executable },
        @{ Name = "SolunaRemote-Integrated-UDP-$suffix"; Protocol = 'UDP'; Ports = @('47998-48000', '48002'); Program = $Executable },
        @{ Name = "SolunaRemote-Access-TCP-$suffix"; Protocol = 'TCP'; Ports = @(47991); Program = $AppExecutable },
        @{ Name = "SolunaRemote-Access-UDP-$suffix"; Protocol = 'UDP'; Ports = @(5353); Program = $AppExecutable }
    )
    $allRules = @(Get-NetFirewallRule -PolicyStore PersistentStore -ErrorAction Stop)
    foreach ($rule in $rules) {
        $existing = @($allRules | Where-Object { $_.Name -eq $rule.Name })
        if ($existing.Count -gt 1) { throw 'Duplicate SolunaRemote firewall rules found.' }
        if ($existing) {
            $filter = $existing | Get-NetFirewallApplicationFilter
            $ports = $existing | Get-NetFirewallPortFilter
            if ((Normalize-ExecutablePath $filter.Program) -ne $rule.Program -or $existing.Direction -ne 'Inbound' -or
                $existing.Action -ne 'Allow' -or $existing.Profile -ne 'Any' -or
                $ports.Protocol -ne $rule.Protocol -or
                (Compare-Object @($ports.LocalPort | ForEach-Object { "$_" } | Sort-Object) @($rule.Ports | ForEach-Object { "$_" } | Sort-Object))) {
                throw 'An existing SolunaRemote rule does not match this installation. No rule was changed.'
            }
        }
    }
    foreach ($rule in $rules) {
        $existing = @($allRules | Where-Object { $_.Name -eq $rule.Name })
        if ($existing) {
            $existing | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -RemoteAddress LocalSubnet | Out-Null
            $existing | Enable-NetFirewallRule
        } else {
            New-NetFirewallRule -Name $rule.Name -DisplayName "SolunaRemote ($($rule.Name))" `
                -Direction Inbound -Action Allow -Protocol $rule.Protocol -LocalPort $rule.Ports `
                -Program $rule.Program -RemoteAddress LocalSubnet -Profile Any | Out-Null
        }
    }
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
