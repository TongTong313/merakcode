#Requires -RunAsAdministrator
[CmdletBinding()]
param([ValidateRange(1, 32)][int]$Count = 4, [Parameter(Mandatory = $true)][string]$StateDir)
. (Join-Path $PSScriptRoot '../../merak/internal/platform/sandbox/scripts/setup-windows.ps1') -Count $Count -StateDir $StateDir
