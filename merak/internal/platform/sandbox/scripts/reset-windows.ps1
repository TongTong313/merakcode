#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$StateDir)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'credential-windows.ps1')
. (Join-Path $PSScriptRoot 'access-windows.ps1')
$statePath = [IO.Path]::GetFullPath($StateDir)
if ($statePath -eq [IO.Path]::GetPathRoot($statePath)) { throw 'The state directory cannot be a drive root.' }
$manifestPath = Join-Path $statePath 'accounts.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$stateItem = Get-Item -LiteralPath $statePath
if ($stateItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The state directory cannot be a reparse point.' }
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($manifest.version -ne 1 -or $manifest.owner -ne $owner -or $manifest.pool -notmatch '^[a-f0-9]{6}$') { throw 'Invalid account pool owner or format.' }
$profilesRoot = [Environment]::ExpandEnvironmentVariables((Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList').ProfilesDirectory)
$profilesRoot = [IO.Path]::GetFullPath($profilesRoot).TrimEnd('\') + '\'
$profiles = @()
$processes = @(Get-Process -IncludeUserName)
foreach ($account in $manifest.accounts) {
    if ($account.name -notmatch ('^merak-sbx-' + $manifest.pool + '-[0-9]{2}$') -or $account.credential -ne "MerakCode/Sandbox/$($manifest.pool)/$($account.name)" -or $account.firewall -notmatch ('^MerakCode-Sandbox-' + $manifest.pool + '-[0-9]+$')) { throw 'Invalid account pool entry.' }
    $user = Get-LocalUser -Name $account.name -ErrorAction SilentlyContinue
    if ($user -and ($user.SID.Value -ne $account.sid -or $user.Description -ne "MerakCode sandbox pool $($manifest.pool)")) { throw 'An account no longer belongs to this pool.' }
    $profile = Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $account.sid }
    if ($profile) {
        $profilePath = [IO.Path]::GetFullPath($profile.LocalPath)
        $leaf = [IO.Path]::GetFileName($profilePath)
        if ($profile.Loaded -or $profile.Special -or -not $profilePath.StartsWith($profilesRoot, [StringComparison]::OrdinalIgnoreCase) -or ($leaf -ne $account.name -and -not $leaf.StartsWith($account.name + '.', [StringComparison]::OrdinalIgnoreCase))) { throw 'The sandbox user profile is loaded or outside its expected directory.' }
        $profiles += $profile
    }
    if ($processes | Where-Object { $_.UserName -eq "$env:COMPUTERNAME\$($account.name)" }) { throw 'Stop all sandbox members before resetting the pool.' }
}
$manifest.ready = $false
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
foreach ($account in $manifest.accounts) {
    $user = Get-LocalUser -Name $account.name -ErrorAction SilentlyContinue
    if ($user) { Disable-LocalUser -SID $user.SID }
    foreach ($suffix in @('', '.deny', '.ancestors')) {
        $journalPath = Join-Path $statePath ("lease-" + $account.name + '.lock.json' + $suffix)
        $removeMode = if ($suffix -eq '.deny') { '/remove:d' } else { '/remove:g' }
        if (Test-Path -LiteralPath $journalPath) {
            $accessRoots = @(Get-Content -LiteralPath $journalPath -Raw | ConvertFrom-Json)
            foreach ($root in $accessRoots) {
                if (-not ($root -is [string]) -or -not [IO.Path]::IsPathRooted($root) -or [IO.Path]::GetFullPath($root) -ne $root) { throw 'Invalid sandbox lease directory.' }
                if (-not (Test-Path -LiteralPath $root)) { continue }
                & "$env:SystemRoot\System32\icacls.exe" $root $removeMode "*$($account.sid)" | Out-Null
                if ($LASTEXITCODE -ne 0) { throw 'Failed to remove sandbox lease access.' }
            }
        }
    }
}
foreach ($profile in $profiles) { $profile | Remove-CimInstance }
if ($manifest.group) {
    if ($manifest.group.name -ne "merak-sbx-$($manifest.pool)") { throw 'Invalid sandbox group name.' }
    $group = Get-LocalGroup -Name $manifest.group.name -ErrorAction SilentlyContinue
    if ($group -and ($group.SID.Value -ne $manifest.group.sid -or $group.Description -ne "MerakCode sandbox pool $($manifest.pool)")) { throw 'The group no longer belongs to this pool.' }
    foreach ($root in @($manifest.denyRoots) + @($manifest.readRoots)) {
        if (-not $root -or -not [IO.Path]::IsPathRooted($root) -or [IO.Path]::GetFullPath($root) -eq [IO.Path]::GetPathRoot($root)) { throw 'Invalid sandbox access directory.' }
        if (-not (Test-Path -LiteralPath $root)) { continue }
        $access = Get-Acl -LiteralPath $root
        [MerakSandboxAccess]::Remove($root, $access.GetSecurityDescriptorBinaryForm(), $manifest.group.sid)
    }
}
foreach ($account in $manifest.accounts) {
    Get-NetFirewallRule -Name $account.firewall -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    [MerakSandboxCredential]::Delete($account.credential)
    $hiddenKey = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList'
    Remove-ItemProperty -Path $hiddenKey -Name $account.name -ErrorAction SilentlyContinue
    $user = Get-LocalUser -Name $account.name -ErrorAction SilentlyContinue
    if ($user) { Remove-LocalUser -SID $user.SID }
}
if ($manifest.group -and $group) { Remove-LocalGroup -SID $group.SID }
if ([IO.Path]::GetFullPath($stateItem.FullName) -ne $statePath -or $statePath -eq [IO.Path]::GetPathRoot($statePath)) { throw 'The state directory changed during reset.' }
Remove-Item -LiteralPath $statePath -Recurse -Force
