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
$AppExecutable = Normalize-ExecutablePath $AppExecutable
$Executable = Normalize-ExecutablePath $Executable
$hasher = [Security.Cryptography.SHA256]::Create()
try {
    $digest = $hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($AppExecutable).ToLowerInvariant()))
    $suffix = ([BitConverter]::ToString($digest) -replace '-', '').Substring(0, 16)
} finally { $hasher.Dispose() }
$rules = @(
    @{ Name = "SolunaRemote-Integrated-TCP-$suffix"; Protocol = 'TCP'; Ports = @('47984', '47989', '48010'); Program = $Executable },
    @{ Name = "SolunaRemote-Integrated-UDP-$suffix"; Protocol = 'UDP'; Ports = @('47998-48000', '48002'); Program = $Executable },
    @{ Name = "SolunaRemote-Access-TCP-$suffix"; Protocol = 'TCP'; Ports = @('47991'); Program = $AppExecutable },
    @{ Name = "SolunaRemote-Access-UDP-$suffix"; Protocol = 'UDP'; Ports = @('5353'); Program = $AppExecutable }
)
$allRules = @(Get-NetFirewallRule -PolicyStore ActiveStore -Name "SolunaRemote-*-$suffix" -ErrorAction SilentlyContinue -ErrorVariable queryErrors)
if ($queryErrors | Where-Object { $_.CategoryInfo.Category -ne 'ObjectNotFound' }) {
    throw ($queryErrors | Select-Object -First 1)
}
foreach ($expected in $rules) {
    $rule = @($allRules | Where-Object { $_.Name -eq $expected.Name })
    if ($rule.Count -ne 1) { exit 3 }
    $rule = $rule[0]
    $application = $rule | Get-NetFirewallApplicationFilter
    $ports = $rule | Get-NetFirewallPortFilter
    $address = $rule | Get-NetFirewallAddressFilter
    if ($rule.Enabled -ne 'True' -or $rule.Direction -ne 'Inbound' -or
        $rule.Action -ne 'Allow' -or $rule.Profile -ne 'Any' -or
        (Normalize-ExecutablePath $application.Program) -ne $expected.Program -or $ports.Protocol -ne $expected.Protocol -or
        (Compare-Object @($ports.LocalPort | Sort-Object) @($expected.Ports | Sort-Object)) -or
        @($address.RemoteAddress).Count -ne 1 -or
        @($address.RemoteAddress)[0] -ne 'LocalSubnet') {
        exit 3
    }
}
exit 0
