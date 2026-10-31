# Spike: the admin-only part of the sandbox setup. Runs elevated, ASCII only, PowerShell 5.1.
# Reads { user, password } from the request file and writes { sid } or { error } to <request>.result.
param([Parameter(Mandatory = $true)][string]$Request)
$ErrorActionPreference = "Stop"
$resultFile = $Request + ".result"
try {
    $req = Get-Content -Raw -Path $Request | ConvertFrom-Json
    $name = $req.user
    $secure = ConvertTo-SecureString $req.password -AsPlainText -Force
    $existing = Get-LocalUser -Name $name -ErrorAction SilentlyContinue
    if ($existing) {
        Set-LocalUser -Name $name -Password $secure
    } else {
        New-LocalUser -Name $name -Password $secure -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires -Description "MerakCode sandbox" | Out-Null
    }
    $users = Get-LocalGroup -SID "S-1-5-32-545"
    if (-not (Get-LocalGroupMember -Group $users -Member $name -ErrorAction SilentlyContinue)) {
        Add-LocalGroupMember -Group $users -Member $name
    }
    $key = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList"
    New-Item -Path $key -Force | Out-Null
    New-ItemProperty -Path $key -Name $name -Value 0 -PropertyType DWord -Force | Out-Null
    $sid = (Get-LocalUser -Name $name).SID.Value
    Get-NetFirewallRule -DisplayName "merakcode-sandbox-block" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName "merakcode-sandbox-block" -Direction Outbound -Action Block `
        -LocalUser "D:(A;;CC;;;$sid)" `
        -RemoteAddress @("0.0.0.0-126.255.255.255", "128.0.0.0-255.255.255.255", "::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff") | Out-Null
    @{ sid = $sid } | ConvertTo-Json | Set-Content -Path $resultFile -Encoding ASCII
} catch {
    @{ error = $_.Exception.Message } | ConvertTo-Json | Set-Content -Path $resultFile -Encoding ASCII
}
