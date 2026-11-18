#Requires -RunAsAdministrator
[CmdletBinding()]
param([ValidateRange(1, 32)][int]$Count = 4, [Parameter(Mandatory = $true)][string]$StateDir)
. (Join-Path $PSScriptRoot '../../merak/engine/infra/sandbox/scripts/setup-windows.ps1') -Count $Count -StateDir $StateDir
