[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$StateDir,
    [Parameter(Mandatory = $true)][string]$InstallDir
)
$ErrorActionPreference = 'Stop'
$statePath = [IO.Path]::GetFullPath($StateDir)
$manifestPath = Join-Path $statePath 'accounts.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($manifest.version -ne 1 -or $manifest.owner -ne $owner -or $manifest.pool -notmatch '^[a-f0-9]{6}$' -or $manifest.group.name -ne "merak-sbx-$($manifest.pool)") { throw 'Invalid account pool owner or group.' }
$group = Get-LocalGroup -Name $manifest.group.name
if ($group.SID.Value -ne $manifest.group.sid) { throw 'The sandbox group identity changed.' }
$roots = @([Environment]::GetFolderPath('UserProfile'), [IO.Path]::GetFullPath($InstallDir)) | Select-Object -Unique
$index = 0
foreach ($root in $roots) {
    $item = Get-Item -LiteralPath $root
    if (-not $item.PSIsContainer -or $item.FullName -eq [IO.Path]::GetPathRoot($item.FullName)) { throw 'Read access requires a non-root directory.' }
    $index++
    Write-Progress -Activity 'Grant sandbox read access' -Status $item.FullName -PercentComplete (($index - 1) * 100 / $roots.Count)
    if ($manifest.readRoots -notcontains $item.FullName) {
        $manifest.readRoots = @($manifest.readRoots) + $item.FullName
        $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
    }
    & "$env:SystemRoot\System32\icacls.exe" $item.FullName /grant "*$($group.SID.Value):(OI)(CI)RX" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to grant sandbox read access.' }
}
$manifest.ready = $true
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
Write-Progress -Activity 'Grant sandbox read access' -Completed
