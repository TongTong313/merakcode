#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$StateDir)
. (Join-Path $PSScriptRoot '../../merak/internal/platform/sandbox/scripts/reset-windows.ps1') -StateDir $StateDir
