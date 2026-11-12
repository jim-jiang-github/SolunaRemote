param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$AppExecutable,
    [Parameter(Mandatory = $true)][string]$Address
)
$ErrorActionPreference = 'Stop'
try {
    $parsed = [Net.IPAddress]::Parse($Address)
    $bytes = $parsed.GetAddressBytes()
    if ($parsed.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
        $parsed.ToString() -ne $Address -or
        -not ($bytes[0] -eq 10 -or
            ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or
            ($bytes[0] -eq 192 -and $bytes[1] -eq 168))) {
        throw 'Only an individual private IPv4 client address is accepted.'
    }
    if (-not [IO.Path]::IsPathRooted($Executable) -or
        -not (Test-Path -LiteralPath $Executable -PathType Leaf) -or
        [IO.Path]::GetFileName($Executable) -ne 'sunshine.exe') {
        throw 'Invalid bundled host executable.'
    }
    if (-not [IO.Path]::IsPathRooted($AppExecutable) -or
        -not (Test-Path -LiteralPath $AppExecutable -PathType Leaf)) {
        throw 'Invalid SolunaRemote executable.'
    }
    $rules = @(
        @{ Name = 'SolunaRemote-Integrated-TCP'; Protocol = 'TCP'; Ports = @(47984, 47989, 48010); Program = $Executable },
        @{ Name = 'SolunaRemote-Integrated-UDP'; Protocol = 'UDP'; Ports = @('47998-48000', '48002'); Program = $Executable },
        @{ Name = 'SolunaRemote-Access-TCP'; Protocol = 'TCP'; Ports = @(47991); Program = $AppExecutable },
        @{ Name = 'SolunaRemote-Access-UDP'; Protocol = 'UDP'; Ports = @(5353); Program = $AppExecutable }
    )
    foreach ($rule in $rules) {
        $existing = Get-NetFirewallRule -Name $rule.Name -ErrorAction SilentlyContinue
        if ($existing) {
            $filter = $existing | Get-NetFirewallApplicationFilter
            if ($filter.Program -ne $rule.Program) {
                throw 'An existing SolunaRemote rule belongs to another installation. No rule was changed.'
            }
        }
    }
    foreach ($rule in $rules) {
        $existing = Get-NetFirewallRule -Name $rule.Name -ErrorAction SilentlyContinue
        if ($existing) {
            $existing | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -RemoteAddress $Address | Out-Null
            $existing | Enable-NetFirewallRule
        } else {
            New-NetFirewallRule -Name $rule.Name -DisplayName "SolunaRemote ($($rule.Name))" `
                -Direction Inbound -Action Allow -Protocol $rule.Protocol -LocalPort $rule.Ports `
                -Program $rule.Program -RemoteAddress $Address -Profile Any | Out-Null
        }
    }
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
