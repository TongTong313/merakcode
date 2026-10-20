# Spike: removes everything setup.ps1 created. Runs elevated, ASCII only, PowerShell 5.1.
param([Parameter(Mandatory = $true)][string]$User, [Parameter(Mandatory = $true)][string]$Result)
$ErrorActionPreference = "Continue"
$log = @()
$account = Get-LocalUser -Name $User -ErrorAction SilentlyContinue
if ($account) {
    $sid = $account.SID.Value
    Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid } | ForEach-Object {
        try { Remove-CimInstance -InputObject $_; $log += "profile removed" } catch { $log += "profile: " + $_.Exception.Message }
    }
    try { Remove-LocalUser -Name $User; $log += "user removed" } catch { $log += "user: " + $_.Exception.Message }
}
Get-NetFirewallRule -DisplayName "merakcode-sandbox-block" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
$log += "firewall rule removed"
$key = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList"
Remove-ItemProperty -Path $key -Name $User -ErrorAction SilentlyContinue
$log += "registry entry removed"
@{ log = $log } | ConvertTo-Json | Set-Content -Path $Result -Encoding ASCII
