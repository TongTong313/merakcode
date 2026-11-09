#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [ValidateRange(1, 32)][int]$Count = 4,
    [Parameter(Mandatory = $true)][string]$StateDir
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'credential-windows.ps1')
$statePath = [IO.Path]::GetFullPath($StateDir)
if ($statePath -eq [IO.Path]::GetPathRoot($statePath)) { throw 'The state directory cannot be a drive root.' }
$manifestPath = Join-Path $statePath 'accounts.json'
if (Test-Path -LiteralPath $manifestPath) { throw 'This account pool already exists. Reset it before initializing it again.' }
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$hash = [Security.Cryptography.SHA256]::Create()
try {
    $digest = $hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($owner + '|' + $statePath.ToLowerInvariant()))
    $pool = ([BitConverter]::ToString($digest) -replace '-', '').Substring(0, 6).ToLowerInvariant()
} finally { $hash.Dispose() }
$description = "MerakCode sandbox pool $pool"
$accounts = @()
$hiddenKey = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList'
[IO.Directory]::CreateDirectory($statePath) | Out-Null
$access = New-Object Security.AccessControl.DirectorySecurity
$access.SetAccessRuleProtection($true, $false)
foreach ($sid in @($owner, 'S-1-5-18', 'S-1-5-32-544')) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
        [Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $access.AddAccessRule($rule)
}
Set-Acl -LiteralPath $statePath -AclObject $access
$groupName = "merak-sbx-$pool"
if (Get-LocalGroup -Name $groupName -ErrorAction SilentlyContinue) { throw 'The sandbox group already exists.' }
$group = New-LocalGroup -Name $groupName -Description $description
$manifest = [ordered]@{ version = 1; owner = $owner; pool = $pool; ready = $false; group = [ordered]@{ name = $group.Name; sid = $group.SID.Value }; readRoots = @(); denyRoots = @(); accounts = @() }
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
$random = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
    for ($index = 1; $index -le $Count; $index++) {
        $name = 'merak-sbx-{0}-{1:00}' -f $pool, $index
        if (Get-LocalUser -Name $name -ErrorAction SilentlyContinue) { throw "Account already exists: $name" }
        $bytes = New-Object byte[] 32
        $random.GetBytes($bytes)
        $password = 'Ma1!' + [Convert]::ToBase64String($bytes)
        $secure = ConvertTo-SecureString -String $password -AsPlainText -Force
        $user = New-LocalUser -Name $name -Password $secure -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword -Description $description
        $account = [ordered]@{ name = $name; sid = $user.SID.Value; credential = "MerakCode/Sandbox/$pool/$name"; firewall = "MerakCode-Sandbox-$pool-$index" }
        $accounts += $account
        $manifest.accounts = $accounts
        $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
        Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $user
        Add-LocalGroupMember -Group $group -Member $user
        New-Item -Path $hiddenKey -Force | Out-Null
        New-ItemProperty -Path $hiddenKey -Name $name -Value 0 -PropertyType DWord -Force | Out-Null
        [MerakSandboxCredential]::Write($account.credential, "$env:COMPUTERNAME\$name", $password)
        $password = $null
        $secure.Dispose()
        [Array]::Clear($bytes, 0, $bytes.Length)
        New-NetFirewallRule -Name $account.firewall -DisplayName $account.firewall -Group 'MerakCode sandbox' -Direction Outbound -Action Block -Profile Any -Enabled True -LocalUser "D:(A;;CC;;;$($account.sid))" -RemoteAddress @('0.0.0.0-126.255.255.255', '128.0.0.0-255.255.255.255', '::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff') | Out-Null
    }
} finally { $random.Dispose() }
Write-Output $manifestPath
