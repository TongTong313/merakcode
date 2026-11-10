[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$StateDir, [Parameter(Mandatory = $true)][string]$InstallDir)
. (Join-Path $PSScriptRoot '../../merak/internal/platform/sandbox/scripts/grant-read-windows.ps1') -StateDir $StateDir -InstallDir $InstallDir
