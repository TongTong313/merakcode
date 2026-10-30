# MerakCode sandbox reset, the part that needs administrator rights. ASCII only, runs on Windows PowerShell 5.1.
# Removes the sandbox account, its user profile, the firewall rule and the hidden-account registry value.
# Folder permissions are removed before this runs: once the account is gone its SID can no longer be resolved.
param([Parameter(Mandatory = $true)][string]$User, [Parameter(Mandatory = $true)][string]$Rule, [Parameter(Mandatory = $true)][string]$Result)
$ErrorActionPreference = "Continue"
$errors = @()
$account = Get-LocalUser -Name $User -ErrorAction SilentlyContinue
if ($account) {
    $sid = $account.SID.Value
    Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid } | ForEach-Object {
        try { Remove-CimInstance -InputObject $_ } catch { $errors += "profile: " + $_.Exception.Message }
    }
    try { Remove-LocalUser -Name $User } catch { $errors += "account: " + $_.Exception.Message }
}
Get-NetFirewallRule -DisplayName $Rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
$key = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList"
Remove-ItemProperty -Path $key -Name $User -ErrorAction SilentlyContinue
@{ errors = $errors } | ConvertTo-Json | Set-Content -Path $Result -Encoding ASCII
